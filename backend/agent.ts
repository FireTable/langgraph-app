import { ChatOpenAI } from "@langchain/openai";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
  // Override the upstream base URL when targeting an OpenAI-compatible
  // endpoint (e.g. a local proxy, Azure, or a third-party gateway).
  ...(process.env.OPENAI_BASE_URL
    ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } }
    : {}),
  streaming: true,
  modelKwargs: {
    // only minimax will use this params
    reasoning_split: true,
  },
});

const callModel = async (state: typeof MessagesAnnotation.State) => {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
};

// Postgres checkpointer for thread persistence. `setup()` is idempotent —
// first call creates the checkpoints / checkpoint_blobs / checkpoint_writes
// tables; subsequent calls are no-ops. Pass `configurable.thread_id` when
// invoking the graph to persist and resume conversations.
const databaseUrl = process.env.DATABASE_URL;
const checkpointer = databaseUrl ? PostgresSaver.fromConnString(databaseUrl) : undefined;
if (checkpointer) await checkpointer.setup();

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addEdge("__start__", "agent")
  .addEdge("agent", "__end__")
  .compile({ checkpointer });
