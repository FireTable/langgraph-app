import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import { joinURL } from "ufo";
import { createAssistantStream } from "assistant-stream";

// Bridges our `/api/threads/*` contract to assistant-ui's
// RemoteThreadListAdapter. Each method is a thin fetch wrapper; no state
// is held here.
//
// URLs are built with `ufo`'s joinURL to normalize slashes and avoid the
// surprises of plain template-literal concatenation (e.g. `//` from a
// trailing slash on the base, or `%2F` collisions if a path segment ever
// contains a slash).
//
// --- Vocabulary boundary -------------------------------------------------
// Our API and DB speak `id` (one concept). assistant-ui's runtime expects
// `remoteId` (the API-side identifier it uses to call back into the
// adapter) AND `externalId` (an optional handle the runtime passes to
// `useStream({ threadId })` so the underlying transport knows which
// thread to load — for us this is the same value as remoteId since our
// threadId IS our DB id). Returning `undefined` for `externalId` makes
// sidebar clicks a no-op (no thread_id → no history load); see the
// useStreamThreadRuntime in @assistant-ui/react-langchain. We deliberately
// do NOT implement unstable_Provider — LangGraph's PostgresSaver already
// restores message history via thread_id, so an additional
// ThreadHistoryAdapter would just shadow that.

const BASE = "/api/threads";

type ApiThreadMetadata = {
  id: string;
  status: "regular" | "archived";
  title?: string;
  lastMessageAt?: Date;
};

async function patchThread(id: string, body: unknown): Promise<void> {
  await fetch(joinURL(BASE, id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Translate our own ThreadMetadata into assistant-ui's RemoteThreadMetadata
// at the boundary. Callers inside this file use `t.remoteId` as if it were
// `t.id`; that's intentional — they're the same value here.
function toRemote(t: ApiThreadMetadata) {
  return {
    status: t.status,
    remoteId: t.id,
    externalId: t.id,
    title: t.title,
    lastMessageAt: t.lastMessageAt,
  };
}

export const threadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const res = await fetch(joinURL(BASE));
    const data = (await res.json()) as { threads: ApiThreadMetadata[] };
    return { threads: data.threads.map(toRemote) };
  },

  async initialize(_localId: string) {
    const res = await fetch(joinURL(BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = (await res.json()) as ApiThreadMetadata;
    return { remoteId: data.id, externalId: data.id };
  },

  async rename(remoteId, title) {
    await patchThread(remoteId, { title });
  },

  async updateCustom(remoteId, custom) {
    await patchThread(remoteId, { custom });
  },

  async archive(remoteId) {
    await patchThread(remoteId, { status: "archived" });
  },

  async unarchive(remoteId) {
    await patchThread(remoteId, { status: "regular" });
  },

  async delete(remoteId) {
    await fetch(joinURL(BASE, remoteId), { method: "DELETE" });
  },

  async fetch(remoteId) {
    const res = await fetch(joinURL(BASE, remoteId));
    const data = (await res.json()) as ApiThreadMetadata;
    return toRemote(data);
  },

  async generateTitle(remoteId, messages) {
    // The runtime calls this after a thread's first run ends, passing the
    // LangGraph thread_id of the thread that just finished. Build the URL
    // with that remoteId directly — earlier versions did a `list()` and
    // used `threads[0]`, which silently targeted the wrong thread any time
    // the runtime's order disagreed with the server's ORDER BY.
    const url = joinURL(BASE, remoteId, "title");
    return createAssistantStream(async (controller) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      const text = await res.text();
      controller.appendText(text);
    });
  },
};
