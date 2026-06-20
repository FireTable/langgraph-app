import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import { joinURL } from "ufo";
import { createAssistantStream } from "assistant-stream";

// Bridges assistant-ui's RemoteThreadListAdapter to our /api/threads/* routes.
// Each method is a thin fetch wrapper; no state is held here.
//
// URLs are built with `ufo`'s joinURL to normalize slashes and avoid the
// surprises of plain template-literal concatenation (e.g. `//` from a
// trailing slash on the base, or `%2F` collisions if a path segment ever
// contains a slash).
//
// `externalId` is the value the runtime passes to `useStream` as
// `threadId` — for us this is the LangGraph thread_id, which we already
// store as the `threads.id` row. Returning `undefined` here would make
// clicking a thread in the sidebar a no-op (no thread_id → no history
// load). See useStreamThreadRuntime in
// @assistant-ui/react-langchain/src/useStreamRuntime.tsx.
//
// We deliberately do NOT implement unstable_Provider — LangGraph's
// PostgresSaver already restores message history via thread_id, so an
// additional ThreadHistoryAdapter would just shadow that.

const BASE = "/api/threads";

async function patchThread(id: string, body: unknown): Promise<void> {
  await fetch(joinURL(BASE, id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const threadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const res = await fetch(joinURL(BASE));
    const data = (await res.json()) as {
      threads: Array<{ status: "regular" | "archived"; remoteId: string; title?: string }>;
    };
    return {
      threads: data.threads.map((t) => ({
        status: t.status,
        remoteId: t.remoteId,
        externalId: t.remoteId,
        title: t.title,
      })),
    };
  },

  async initialize(_localId: string) {
    const res = await fetch(joinURL(BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = (await res.json()) as { remoteId: string };
    return { remoteId: data.remoteId, externalId: data.remoteId };
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
    const data = (await res.json()) as {
      status: "regular" | "archived";
      remoteId: string;
      title?: string;
    };
    return { ...data, externalId: data.remoteId };
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
