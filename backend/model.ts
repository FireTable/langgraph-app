import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import type { Embeddings } from "@langchain/core/embeddings";

import {
  getChatModelFromDB,
  getEmbeddingModelFromDB,
  getVlmModelFromDB,
  invalidateModelCache,
  type GetChatModelOpts,
} from "@/lib/provider/model-registry";

function buildEnvChatModel(): ChatOpenAI {
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

// ponytail: vlm reuses the chat-model env vars today (vision-capable
// chat models handle image_url content). When a non-chat VLM provider
// lands (e.g. a vision-only upstream) this builder splits off.
function buildEnvVlmModel(): ChatOpenAI {
  return buildEnvChatModel();
}

function buildEnvEmbeddingModel(): Embeddings {
  return new OpenAIEmbeddings({
    model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    apiKey: process.env.OPENAI_API_KEY,
    ...(process.env.OPENAI_BASE_URL
      ? {
          configuration: {
            baseURL: process.env.OPENAI_BASE_URL,
          },
        }
      : {}),
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
    return buildEnvChatModel();
  }
}

/**
 * VLM = chat-capable model with vision (image_url) support. Same
 * round-robin pool key as chat, but `kind="vlm"` filter — chat-only
 * models are excluded. Falls back to env-built ChatOpenAI on miss.
 */
export async function getVlmModel(opts: GetChatModelOpts = {}): Promise<ChatOpenAI> {
  try {
    return (await getVlmModelFromDB(opts)) as ChatOpenAI;
  } catch {
    return buildEnvVlmModel();
  }
}

/**
 * Embedding model entry point. Same fallback chain as chat: registry
 * first, env on miss. Returns Embeddings interface (not chat) — caller
 * chains `.embedDocuments` / `.embedQuery`, not `.invoke`.
 */
export async function getEmbeddingModel(opts: GetChatModelOpts = {}): Promise<Embeddings> {
  try {
    return await getEmbeddingModelFromDB(opts);
  } catch {
    return buildEnvEmbeddingModel();
  }
}

export { invalidateModelCache };
export type { GetChatModelOpts };
