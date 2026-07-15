import { randomUUID } from "node:crypto";

import { langGraphClient } from "@/lib/langgraph/client";

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
};

export async function fireIngestionRun({
  userId,
  attachment,
  docId,
  title,
  source = "kb-settings",
}: FireIngestionOpts): Promise<void> {
  const base = process.env.R2_PUBLIC_BASE_URL ?? "";
  const publicUrl = `${base}/${attachment.r2Key}`;

  const threadId = `t-${randomUUID()}`;
  // ponytail: register the thread id with the dev server's in-process
  // checkpointer (see lib/langgraph/client.ts). No-op in prod.
  await langGraphClient.threads.create({ threadId, ifExists: "do_nothing" });

  // JSON-serializable message shape — the graph's MessagesValue reducer
  // reconstructs HumanMessage on the server. file_part matches the
  // assistant-ui wire format that kbAgent expects.
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
            filename: attachment.name,
          },
        ],
      },
    ],
  };

  const config = {
    configurable: {
      userId,
      thread_id: threadId,
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
