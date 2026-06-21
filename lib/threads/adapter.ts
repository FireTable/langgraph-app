import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import { joinURL } from "ufo";
import { createAssistantStream } from "assistant-stream";

// Bridges our `/api/threads/*` contract to assistant-ui's
// RemoteThreadListAdapter. Each method is a thin fetch wrapper; no state
// is held here. URLs are built with `ufo`'s joinURL so trailing slashes
// or `%2F` collisions can't sneak into path segments.
//
// We do NOT implement unstable_Provider — LangGraph's PostgresSaver
// already restores message history via thread_id, so an additional
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

// assistant-ui expects `remoteId` (callback into the adapter) AND
// `externalId` (threadId passed to useStream — must NOT be undefined or
// sidebar clicks become no-ops). Our DB has one id, so we set both to it.
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

  async generateTitle(remoteId, _messages) {
    return createAssistantStream(async (controller) => {
      const threadData = await this.fetch(remoteId);
      if (typeof threadData.title === "string") {
        controller.appendText(threadData.title);
      }
    });
  },
};
