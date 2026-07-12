import { ChatOpenAI } from "@langchain/openai";

import {
  getChatModel,
  invalidateModelCache,
} from "@/lib/provider/model-registry";

// Legacy sync export — preserved for the 7 `createAgent({ llm: chatModel })`
// consumers that take the model at module load. Source of truth is still
// the env vars (matches the pre-DB-backed behavior). New callers should
// use `getChatModel()` to read from the DB-backed registry.
export const chatModel: ChatOpenAI = new ChatOpenAI({
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

// ponytail: kick off a background warmup so the LRU inside model-registry
// is primed before the first /chat request. Failures are silent — the
// env fallback above stays in place for legacy consumers and the next
// getChatModel() call retries the DB lookup.
void getChatModel().catch(() => {});

export { getChatModel, invalidateModelCache };