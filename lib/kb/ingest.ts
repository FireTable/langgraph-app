import { randomUUID } from "node:crypto";

import { langGraphClient } from "@/lib/langgraph/client";
import { stampKbRefOnFilename } from "@/lib/kb/extract";

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
  // knobs (e.g. "kb-reprocess" vs "kb-settings") can diverge without a
  // schema change. Defaults to "kb-settings" for the upload route.
  source?: "kb-settings" | "kb-reprocess";
  // ponytail: chunksOnly dispatch for
  // `POST /api/kb/documents/[id]/reprocess?chunksOnly=true`. Skips
  // the OCR stage — kbAgent reads `doc.pages[].markdown` directly
  // and only the chunk + embed + entity stage runs. kb_documents.row
  // stays at its terminal status (no reset). Ignored for fresh
  // uploads (the route never sends it for kb-settings).
  chunksOnly?: boolean;
  mode?: "full" | "chunksOnly" | "retryFailed" | "retryFailedChunks";
};

export async function fireIngestionRun({
  userId,
  attachment,
  docId,
  title,
  source = "kb-settings",
  chunksOnly = false,
  mode,
}: FireIngestionOpts): Promise<void> {
  const base = process.env.R2_PUBLIC_BASE_URL ?? "";
  const publicUrl = `${base}/${attachment.r2Key}`;

  // ponytail: dev-server LangGraph API 1.4.1 validates every
  // thread_id via `z.string().uuid()`. The bare `randomUUID()` is the
  // minimum legal shape; the older `t-` prefix it carried triggered a
  // 400 (Invalid uuid) and the run silently dropped — the kb_document
  // row then sat at `pending` forever because no node ever updated it.
  // The id is only used to register this synthetic ingest thread with
  // the dev checkpointer; the docId in metadata.docId is the human-
  // meaningful handle.
  const threadId = randomUUID();
  // ponytail: register the thread id with the dev server's in-process
  // checkpointer (see lib/langgraph/client.ts). No-op in prod.
  await langGraphClient.threads.create({ threadId, ifExists: "do_nothing" });

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
    messages: [
      {
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
  const resolvedMode = mode ?? (chunksOnly ? "chunksOnly" : "full");
  const config = {
    configurable: {
      userId,
      thread_id: threadId,
      mode: resolvedMode,
      docId,
      forceRerun: source === "kb-reprocess",
    },
  };

  // Fire-and-forget: kbAgent mutates the kb_document row's status as it
  // progresses. The two existing call sites (POST /api/kb/upload and
  // POST /api/kb/documents/[id]/reprocess) return 202 immediately so
  // their caller can poll the row.
  void langGraphClient.runs.create(threadId, "kbAgent", {
    input,
    config,
    metadata: { source, docId, title },
  });
}
