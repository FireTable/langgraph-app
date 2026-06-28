import { z } from "zod";
import { StateSchema, MessagesValue } from "@langchain/langgraph";

// Router-agent graph state: messages (shared with sub-agents) plus
// the router's per-turn decision, which lives only on the parent.
// Sub-agents don't read or write `routerDecision`, so it stays out
// of their state schema (Pattern A from the LangGraph subgraph docs:
// different schemas → wrapper node transforms messages in/out).
export const RouterAgentState = new StateSchema({
  messages: MessagesValue,
  routerDecision: z.object({
    next: z.enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent"]),
  }),
});

// Shared by chat-agent and weather-agent. Only `messages` flows
// across the parent ↔ subgraph boundary.
export const CommonAgentState = new StateSchema({
  messages: MessagesValue,
});
