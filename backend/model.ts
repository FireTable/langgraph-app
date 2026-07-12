import { ChatOpenAI } from "@langchain/openai";

import {
  getChatModelFromDB,
  invalidateModelCache,
  type GetChatModelOpts,
} from "@/lib/provider/model-registry";

function buildEnvModel(): ChatOpenAI {
  return new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY,
    ...(process.env.OPENAI_BASE_URL
      ? {
          configuration: {
            baseURL: process.env.OPENAI_BASE_URL,
          },
        }
      : {}),
    streaming: true,
    modelKwargs: {
      // only minimax will use this param
      reasoning_split: true,
    },
  });
}

/**
 * Canonical entry point for runtime chat-model lookup. Tries the DB-backed
 * registry first (with LRU caching + admin CUD invalidation); on miss /
 * DB unreachable, falls back to a ChatOpenAI built from env vars so the
 * backend still serves requests in dev before the seed provider is wired.
 *
 * Return type stays ChatOpenAI (not BaseChatModel) because 6 consumers
 * chain `.bindTools(...).invoke(...)` and `bindTools` is optional on the
 * wider type. The registry hard-codes ChatOpenAI today; if a non-OpenAI
 * provider lands, this cast moves to a typed adapter at that boundary.
 */
export async function getChatModel(opts: GetChatModelOpts = {}): Promise<ChatOpenAI> {
  try {
    return (await getChatModelFromDB(opts)) as ChatOpenAI;
  } catch {
    return buildEnvModel();
  }
}

export { invalidateModelCache };
export type { GetChatModelOpts };
