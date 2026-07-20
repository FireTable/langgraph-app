import { randomUUID } from "node:crypto";

import { langGraphClient } from "@/lib/langgraph/client";
import { stampKbRefOnFilename } from "@/lib/kb/extract";
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";

// ponytail: shared ingestion path for the KB Settings "+" and the
// per-row reprocess button. Both call `fireIngestionRun` with a
// synthetic HumanMessage carrying the R2 file part; kbAgent (now
// registered as a top-level assistant in langgraph.json) handles the
// screenshot → OCR → chunk → embed pipeline in one invocation.
//
// We deliberately skip the mainAgent graph here. The mainAgent path
// runs router → kbAgent (subgraph) → renameThreadAgent + the chat
// stream shell — none of which the synthetic "ingest this file"
// thread needs. Calling the kbAgent assistant directly drops the
// router LLM call and the renameThreadAgent LLM call per ingestion.

export type IngestionAttachment = {
  r2Key: string;
  contentType: string;
  name: string;
};

export type FireIngestionOpts = {
  userId: string;
  attachment: IngestionAttachment;
  docId: string;
  title: string;
  // ponytail: caller-supplied source so observability + future per-source
  // knobs (e.g. "kb-reprocess" vs "kb-upload") can diverge without a
  // schema change. Defaults to "kb-upload" for the upload route.
  source?: "kb-upload" | "kb-reprocess";
  // ponytail: chunksOnly dispatch for
  // `POST /api/kb/documents/[id]/reprocess?chunksOnly=true`. Skips
  // the OCR stage — kbAgent reads `doc.pages[].markdown` directly
  // and only the chunk + embed + entity stage runs. kb_documents.row
  // stays at its terminal status (no reset). Ignored for fresh
  // uploads (the route never sends it for kb-upload).
  chunksOnly?: boolean;
  mode?: "full" | "chunksOnly" | "retryFailed" | "retryFailedChunks";
};

export async function fireIngestionRun({
  userId,
  attachment,
  docId,
  title,
  source = "kb-upload",
  chunksOnly = false,
  mode,
}: FireIngestionOpts): Promise<void> {
  const base = process.env.R2_PUBLIC_BASE_URL ?? "";
  const publicUrl = `${base}/${attachment.r2Key}`;

  // ponytail: threadId is derived from docId (strip the `d-` namespace
  // prefix) so every reprocess of the same doc lands on the same
  // LangGraph thread — observability spans accumulate under a stable
  // thread_id and the per-doc trace view shows run history.
  // ponytail: bare UUID shape satisfies the dev server's z.string().uuid()
  // validator; the older `d-` / `t-` prefixes both 400'd.
  // ponytail: Postgres `threads` row is upserted in
  // prepareKBDataNode (kb-agent.ts) where the graph first sees the
  // thread_id — keeps thread lifecycle next to where it's actually
  // used. No need to pre-create the LangGraph dev-server thread;
  // runs.create + the standalone checkpointer materialize it lazily.
  const threadId = docId.replace(/^d-/, "");
  // ponytail: per-run traceId — stamped onto the synthetic HumanMessage.id
  // so CapturingHandler picks it up via lastHumanMessageId and tags every
  // span with meta.parent_message_id = traceId. Without it, pmid is null
  // and the per-turn observability route 404s.
  const messageId = randomUUID();

  // JSON-serializable message shape — the graph's MessagesValue reducer
  // reconstructs HumanMessage on the server. file_part matches the
  // assistant-ui wire format that kbAgent expects.
  //
  // ponytail: stamp the kb_ref prefix on the filename BEFORE handing the
  // message to kbAgent. The Settings → Add Doc / Reprocess paths both
  // already know the docId at fire time (we generated it before calling
  // fireIngestionRun), so we can put the marker on from the start —
  // kbAgent's rewrite then sees an already-stamped file part and
  // stampKbRefOnFilename's idempotency makes that a no-op. Marking
  // here also keeps the marker consistent with chat ingest, where
  // kbAgent stamps on the user's HumanMessage right after the pipeline
  // finishes.
  const input = {
    userId: userId,
    threadId: threadId,
    messages: [
      {
        id: messageId,
        type: "human",
        content: [
          { type: "text", text: "ingest this file" },
          {
            type: "file",
            data: publicUrl,
            mime_type: attachment.contentType,
            filename: stampKbRefOnFilename(attachment.name, docId),
            metadata: { filename: stampKbRefOnFilename(attachment.name, docId) },
          },
        ],
      },
    ],
  };

  // ponytail: mode mode is plumbed through config.configurable
  // because prepareKBDataNode reads `config.configurable.mode` first
  // (before state.mode). The docId in this case IS the target row
  // we want to re-chunk — pass it explicitly so prepareKBDataNode
  // can find the doc by id instead of doing an attachment/file-part
  // lookup chain.
  //
  // ponytail: source is the only signal kbAgent needs to decide
  // fire-and-forget (chat) vs awaited (standalone). The chat subgraph
  // path inherits no source from mainAgent → defaults to "chat"
  // inside the agent → generateChunkEmbedNode doesn't await. We stamp
  // source='kb-upload' / 'kb-reprocess' here so the standalone path
  // awaits the chunk + embed + entity-extract pass before returning,
  // making the route's 202 contract land with chunks already indexed
  // and the first kb_document.status poll seeing the terminal state.
  const resolvedMode = mode ?? (chunksOnly ? "chunksOnly" : "full");
  const config = {
    configurable: {
      userId,
      thread_id: threadId,
      mode: resolvedMode,
      docId,
      source,
      forceRerun: source === "kb-reprocess",
    },
  };

  const metadata = {
    source,
    docId,
    title,
    parent_message_id: messageId,
  };

  if (threadId) {
    await db
      .insert(threads)
      .values({ id: threadId, userId, kind: "kb" })
      .onConflictDoNothing({ target: threads.id });
  }

  await langGraphClient.threads.create({
    threadId,
    ifExists: "do_nothing",
  });

  // Fire-and-forget: kbAgent mutates the kb_document row's status as it
  // progresses. The two existing call sites (POST /api/kb/upload and
  // POST /api/kb/documents/[id]/reprocess) return 202 immediately so
  // their caller can poll the row.
  //
  // ponytail: multitaskStrategy:'interrupt' makes a fresh reprocess
  // cancel any in-flight run on the same thread (same docId → same
  // thread). Without this, the second reprocess queues behind the
  // first and the user clicks "reprocess" again, sees nothing change
  // until the prior run drains — latest wins is the right semantic
  // here. Compare with triggerBackgroundAgentNode which uses 'enqueue'
  // because bg work should chain behind chat, not abort it.
  await langGraphClient.runs.create(threadId, "kbAgent", {
    input,
    config,
    metadata,
    multitaskStrategy: "interrupt",
  });
}
