import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";

import { auth } from "@/lib/auth/config";
import { getProfileDoc, getRecentThreadSummaries, getSocialAccounts } from "@/lib/memory/queries";
import { MEMORY_THREAD_RECALL_LIMIT } from "@/lib/memory/constants";

type RecallOptions = RunnableConfig & { configurable?: { userId?: unknown; headers?: Headers } };

function extractUserId(options?: RecallOptions): string | null {
  const raw = options?.configurable?.userId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function extractHeaders(options?: RecallOptions): Headers {
  return (options?.configurable as { headers?: Headers } | undefined)?.headers ?? new Headers();
}

// ponytail: read profile + session + socialAccounts + thread summaries
// with `.catch(() => null)` so a transient DB blip doesn't break the
// chat. The recall is best-effort: a degraded call is the better failure
// mode than a thrown model error (FR-007 spirit).
async function buildMemoryPayload(userId: string, headers: Headers): Promise<unknown> {
  const [profile, session, socialAccounts, threads] = await Promise.all([
    getProfileDoc(userId).catch((e: unknown) => {
      console.warn("[memory] profile fetch failed", e);
      return {};
    }),
    auth.api.getSession({ headers }).catch((e: unknown) => {
      console.warn("[memory] session fetch failed", e);
      return null;
    }),
    getSocialAccounts(userId).catch((e: unknown) => {
      console.warn("[memory] socialAccounts fetch failed", e);
      return [];
    }),
    getRecentThreadSummaries(userId, MEMORY_THREAD_RECALL_LIMIT).catch((e: unknown) => {
      console.warn("[memory] thread summaries fetch failed", e);
      return [];
    }),
  ]);
  return {
    profile,
    session: session?.user
      ? {
          name: session.user.name ?? null,
          email: session.user.email ?? null,
          image: session.user.image ?? null,
        }
      : { name: null, email: null, image: null },
    socialAccounts,
    threads,
  };
}

export function withMemoryRecall<T extends BaseChatModel>(model: T): T {
  // ponytail: a Proxy intercepts only `.invoke`. Everything else
  // (`bindTools`, `withConfig`, `stream`, `batch`, ...) forwards to
  // the inner ChatOpenAI — call sites stay identical.
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === "invoke") {
        return async (messages: BaseMessage | BaseMessage[], options?: RecallOptions) => {
          const userId = extractUserId(options);
          if (!userId) return target.invoke(messages as never, options as never);
          const headers = extractHeaders(options);
          const payload = await buildMemoryPayload(userId, headers);
          const block = `<memory>${JSON.stringify(payload)}</memory>`;
          const sysMsg = new SystemMessage(block);
          const list = Array.isArray(messages) ? messages : [messages];
          const merged = [sysMsg, ...list];
          return target.invoke(merged as never, options as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
