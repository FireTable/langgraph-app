import { ChatOpenAI } from "@langchain/openai";

const commonOptions = {
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL
    ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } }
    : {}),
  streaming: true,
};

// Shared chat model instance. LangGraph node functions import this so the
// underlying OpenAI client (and its HTTP connection pool) is reused across
// invocations. Override the upstream base URL when targeting an
// OpenAI-compatible endpoint (local proxy, Azure, third-party gateway).
export const chatModel = new ChatOpenAI({
  ...commonOptions,
  modelKwargs: {
    // only minimax will use this param
    reasoning_split: true,
  },
});

export const chatModelWithoutThink = new ChatOpenAI({
  ...commonOptions,
  modelKwargs: {
    reasoning_split: true,
  },
});

