import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import type { Embeddings } from "@langchain/core/embeddings";

import {
  getChatModelFromDB,
  getEmbeddingModelFromDB,
  getExtractModelFromDB,
  getOcrModelFromDB,
  getRerankModelFromDB,
  invalidateModelCache,
  type GetChatModelOpts,
  type RerankModel,
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

// ponytail: ocr reuses the chat-model env vars today (vision-capable
// chat models handle image_url content for OCR). When a non-chat
// vision upstream lands (e.g. a vision-only OCR service) this
// builder splits off.
function buildEnvOcrModel(): ChatOpenAI {
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
 * OCR = chat-capable model used to extract text from rendered PDF
 * pages (image_url → markdown). Same round-robin pool key as chat,
 * but `kind="ocr"` filter — chat-only models are excluded. Falls
 * back to env-built ChatOpenAI on miss.
 */
export async function getOcrModel(opts: GetChatModelOpts = {}): Promise<ChatOpenAI> {
  try {
    return (await getOcrModelFromDB(opts)) as ChatOpenAI;
  } catch {
    return buildEnvOcrModel();
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

/**
 * ponytail: structured-output extraction (KB chunk → entity / relationship /
 * theme triples) routes to `kind="extract"` models. Today's chat-LLM
 * call sites for this work resolve here. `getExtractModelFromDB` falls
 * back to the chat pool when no extract-tagged model is registered,
 * so the wrapper doesn't need its own env fallback — by the time the
 * inner fallback fires, we've already degraded to chat.
 */
export async function getExtractModel(opts: GetChatModelOpts = {}): Promise<ChatOpenAI> {
  return (await getExtractModelFromDB(opts)) as ChatOpenAI;
}

/**
 * Retrieve the rerank model. If none is configured in DB, returns null,
 * allowing caller to gracefully skip reranking.
 */
export async function getRerankModel(opts: GetChatModelOpts = {}): Promise<RerankModel | null> {
  try {
    return await getRerankModelFromDB(opts);
  } catch {
    return null;
  }
}

export { invalidateModelCache };
export type { GetChatModelOpts };
