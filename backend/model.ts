import { ChatOpenAI } from "@langchain/openai";

import { withMemoryRecall } from "@/backend/middleware/with-memory-recall";

const commonOptions = {
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL
    ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } }
    : {}),
  streaming: true,
};

const baseChatModel = new ChatOpenAI({
  ...commonOptions,
  modelKwargs: {
    // only minimax will use this param
    reasoning_split: true,
  },
});

// ponytail: rename is a background task that runs *before* the user
// starts chatting — it must NOT prefill the model with profile /
// threads context that belongs to a different user. Keep the un-wrapped
// export for that node; only chatModel gets the recall wrapper.
export const chatModel = withMemoryRecall(baseChatModel);

export const chatModelWithoutThink = new ChatOpenAI({
  ...commonOptions,
  modelKwargs: {
    reasoning_split: true,
  },
});
