import { ChatOpenAI } from "@langchain/openai";

const commonOptions = {
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL
    ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } }
    : {}),
  streaming: true,
};

// ponytail: callbacks are injected by the graph compile step (see
// backend/agent.ts) so the handler fires on every LangGraph node,
// including ToolNode — model.withConfig({callbacks}) only attaches
// to the chatModel.invoke boundary and tool nodes stay blind to it.
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
