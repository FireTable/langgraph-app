import { Annotation, MessagesAnnotation, START, END, StateGraph, Send } from "@langchain/langgraph";
import { callModelNode } from "@/backend/node/call-model-node";
import { renameThreadNode } from "@/backend/node/rename-thread-node";
import { checkpointer } from "@/backend/checkpointer";

// Graph state extends the standard messages annotation with a `title`
// channel. `title` is null on the first run; renameThreadNode writes it
// via its return value, and the reducer (`(_prev, next) => next`) makes
// subsequent turns observe a non-null title — the node's own guard then
// short-circuits without calling the LLM.
const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  title: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

// Fan out to `agent` and `renameThread` in parallel from START. The run-
// once guard for renameThread lives inside the node (see rename-thread-
// node.ts) — there is no conditional edge here because fan-out has no
// intermediate "gate" position to put one in.
const fanOut = (state: typeof GraphState.State) => [
  new Send("agent", state),
  new Send("renameThread", state),
];

export const graph = new StateGraph(GraphState)
  .addNode("agent", callModelNode)
  .addNode("renameThread", renameThreadNode)
  .addConditionalEdges(START, fanOut, ["agent", "renameThread"])
  .addEdge("agent", END)
  .addEdge("renameThread", END)
  .compile({ checkpointer });
