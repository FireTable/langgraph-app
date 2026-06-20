import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";

// Bridges assistant-ui's RemoteThreadListAdapter to our /api/threads/* routes.
// Each method is a thin fetch wrapper; no state is held here.
//
// We deliberately do NOT implement unstable_Provider — LangGraph's
// PostgresSaver already restores message history via thread_id, so an
// additional ThreadHistoryAdapter would just shadow that.

const BASE = "/api/threads";

async function patchThread(id: string, body: unknown): Promise<void> {
  await fetch(`${BASE}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const threadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const res = await fetch(BASE);
    const data = (await res.json()) as {
      threads: Array<{ status: "regular" | "archived"; remoteId: string; title?: string }>;
    };
    return {
      threads: data.threads.map((t) => ({
        status: t.status,
        remoteId: t.remoteId,
        title: t.title,
      })),
    };
  },

  async initialize(_localId: string) {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = (await res.json()) as { remoteId: string };
    return { remoteId: data.remoteId, externalId: undefined };
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
    await fetch(`${BASE}/${remoteId}`, { method: "DELETE" });
  },

  async fetch(remoteId) {
    const res = await fetch(`${BASE}/${remoteId}`);
    return (await res.json()) as {
      status: "regular" | "archived";
      remoteId: string;
      title?: string;
    };
  },

  async generateTitle(_remoteId, messages) {
    // Pick the most recent thread via list(). The route lives at
    // /api/threads/[id]/title; the remoteId here is the same as the
    // LangGraph thread_id, so the backend already knows what thread it is.
    const list = await this.list();
    const target = list.threads[0];
    if (!target) throw new Error("No thread to generate title for");
    const url = `${BASE}/${target.remoteId}/title`;
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
