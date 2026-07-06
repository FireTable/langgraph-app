import { ChatOpenAI } from "@langchain/openai";

const commonOptions = {
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL
    ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } }
    : {}),
  streaming: true,
};

// ponytail: memory injection lives in each model node via
// buildSystemMessageWithMemory (backend/memory/template.ts) — the node
// reads userId from its RunnableConfig and prepends a <memory> block
// to the system message before invoking the model. The model export
// is intentionally un-wrapped: the CapturingHandler callback is wired
// at the graph level in backend/agent.ts so spans aren't double-fired
// for nested model calls.
export const chatModel: ChatOpenAI = new ChatOpenAI({
  ...commonOptions,
  modelKwargs: {
    // only minimax will use this param
    reasoning_split: true,
  },
});
