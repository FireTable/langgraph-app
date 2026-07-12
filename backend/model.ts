import { ChatOpenAI } from "@langchain/openai";

import {
  getChatModel,
  invalidateModelCache,
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

// ponytail: legacy export for the 7 `createAgent({ llm: chatModel })`
// consumers that take the model at module load. Top-level await blocks
// the module's evaluation until the DB lookup resolves, then we cache
// the result here for those consumers. On DB failure (migration not yet
// applied, replica unreachable, etc.) we fall back to env so the backend
// still boots in dev. New callers should use `getChatModel()` to
// benefit from the LRU cache on the async path.
//
// Type stays ChatOpenAI (not BaseChatModel) because 6 of the consumers
// chain `.bindTools(...).invoke(...)` — `bindTools` is optional on
// BaseChatModel but required on ChatOpenAI, so the wider type breaks
// every callsite. The registry hard-codes ChatOpenAI today; if a future
// provider switch adds non-OpenAI models, this cast moves to a typed
// adapter at that boundary.
export const chatModel: ChatOpenAI = await (async (): Promise<ChatOpenAI> => {
  try {
    return (await getChatModel()) as ChatOpenAI;
  } catch {
    return buildEnvModel();
  }
})();

export { getChatModel, invalidateModelCache };