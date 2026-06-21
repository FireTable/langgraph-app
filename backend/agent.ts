import { Annotation, MessagesAnnotation, START, END, StateGraph } from "@langchain/langgraph";
import { callModelNode } from "@/backend/node/call-model-node";
import { renameThreadNode } from "@/backend/node/rename-thread-node";
import { checkpointer } from "@/backend/checkpointer";

// Graph state extends the standard messages annotation with a `title`
// channel. `title` is null on first run (rename-thread node fills it);
// once set, the afterAgent conditional skips renameThread on subsequent
// runs so we don't regenerate the title for every turn.
const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  title: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

// Run renameThread only on the first turn (state.title == null). On
// subsequent turns jump straight to END.
//
// We run renameThread sequentially after `agent` rather than in parallel
// via Send — the parallel fan-out didn't propagate the renameThread node's
// `title` return back into the main graph state in our LangGraph version.
// The user-visible cost is a brief delay between the chat response and
// the title appearing in the sidebar; we can revisit parallel fan-out
// when we move to a LangGraph version that supports it.
const afterAgent = (state: typeof GraphState.State) => (state.title ? END : "renameThread");

export const graph = new StateGraph(GraphState)
  .addNode("agent", callModelNode)
  .addNode("renameThread", renameThreadNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", afterAgent, {
    renameThread: "renameThread",
    [END]: END,
  })
  .addEdge("renameThread", END)
  .compile({ checkpointer });
