import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { evalRun, evalRubric, evalBenchmark } from "@/lib/eval/schema";
import { observabilitySpans, type NewObservabilitySpanRow } from "@/lib/observability/schema";
import { threads as threadTable } from "@/lib/threads/schema";
import { capturingHandler, creditTrackingHandler } from "@/backend/callbacks";
import { recordEvalRun as recordEvalRunQuery, saveJudgment } from "@/lib/eval/queries";
import { generateId } from "@/lib/ids/nanoid";
import { getEvalModelFromDB } from "@/lib/provider/model-registry";
import { store } from "@/backend/store";
import { checkpointer } from "@/backend/checkpointer";

import { chatAgent } from "@/backend/agent/chat-agent";
import { weatherAgent } from "@/backend/agent/weather-agent";
import { cryptoAgent } from "@/backend/agent/crypto-agent";
import { codeAgent } from "@/backend/agent/code-agent";
import { kbAgent } from "@/backend/agent/kb-agent";
import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { threadSummarizeNode } from "@/backend/node/thread-summarize-node";

import type { RunnableConfig } from "@langchain/core/runnables";

export const EvalAgentState = new StateSchema({
  // ponytail: mode is the entry discriminator — defaults to "judge" so
  // existing callers (api/eval/judge, etc.) keep working without
  // changing their input shape. Benchmark mode isolates the per-agent
  // prompt run + judge into one LangGraph invocation; the route only
  // has to resolve { targetAgent, inputPrompt, ... } server-side and
  // hand off to the graph.
  mode: z.enum(["judge", "benchmark"]).default("judge"),

  // judge mode input
  runId: z.string().optional(), // also populated by recordEvalRun in benchmark mode
  rubricId: z.string().default("rubric_default"),

  // benchmark mode input (resolved server-side by Next.js from
  // benchmarkId; ad-hoc also accepted)
  benchmarkId: z.string().optional(),
  targetAgent: z.string().optional(),
  inputPrompt: z.string().optional(),
  expectedOutput: z.string().optional(),

  // output fields shared by both modes
  status: z.enum(["pending", "completed", "failed"]).default("pending"),
  errorMessage: z.string().nullable().default(null),
  lastMessage: z.unknown().optional(),
  totalMs: z.number().optional(),

  // benchmark-internal carrier fields
  dispatchAt: z.number().optional(),
  benchmarkThreadId: z.string().optional(),
  parentMessageId: z.string().optional(),
});

// ─── No-op source nodes (only purpose: provide a target for
// ─── `addConditionalEdges` so the graph can read state and dispatch).

async function inputRouter() {
  return {};
}

// Pre-dispatch: stamp dispatchAt so recordEvalRun can compute the
// actual end-to-end delta from when the user submitted the benchmark
// to when the agent finished.
async function preDispatchNode() {
  return { dispatchAt: Date.now() };
}

async function benchmarkDispatch() {
  return {};
}

// ─── Per-target invocation nodes. Each one wraps the underlying compiled
// ─── sub-graph or raw node, captures lastMessage + totalMs and pushes
// ─── it to parent state. The routing itself is still 100% edge-driven
// ─── via routeByTargetAgent; there is no central map table here.

async function invokeChatAgent(state: { inputPrompt?: string }, config?: RunnableConfig) {
  const startedAt = Date.now();
  const result = await chatAgent.invoke(
    { messages: [new HumanMessage(state.inputPrompt ?? "")] },
    config,
  );
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return {
    lastMessage: messages.at(-1) ?? null,
    totalMs: Date.now() - startedAt,
  };
}

async function invokeWeatherAgent(state: { inputPrompt?: string }, config?: RunnableConfig) {
  const startedAt = Date.now();
  const result = await weatherAgent.invoke(
    { messages: [new HumanMessage(state.inputPrompt ?? "")] },
    config,
  );
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return {
    lastMessage: messages.at(-1) ?? null,
    totalMs: Date.now() - startedAt,
  };
}

async function invokeCryptoAgent(state: { inputPrompt?: string }, config?: RunnableConfig) {
  const startedAt = Date.now();
  const result = await cryptoAgent.invoke(
    { messages: [new HumanMessage(state.inputPrompt ?? "")] },
    config,
  );
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return {
    lastMessage: messages.at(-1) ?? null,
    totalMs: Date.now() - startedAt,
  };
}

async function invokeCodeAgent(state: { inputPrompt?: string }, config?: RunnableConfig) {
  const startedAt = Date.now();
  const result = await codeAgent.invoke(
    { messages: [new HumanMessage(state.inputPrompt ?? "")] },
    config,
  );
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return {
    lastMessage: messages.at(-1) ?? null,
    totalMs: Date.now() - startedAt,
  };
}

async function invokeKbAgent(state: { inputPrompt?: string }, config?: RunnableConfig) {
  // ponytail: kbAgent's compiled pipeline expects KB document state;
  // for an ad-hoc benchmark prompt with no document, the first node
  // short-circuits to the chat-style fallback. Per-step kbOcr /
  // kbEntityExtract / kbEntityAlign benchmarks stay mapped to the
  // full kbAgent for now — splits are future work.
  const startedAt = Date.now();
  const result = await kbAgent.invoke(
    { messages: [new HumanMessage(state.inputPrompt ?? "")] },
    config,
  );
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return {
    lastMessage: messages.at(-1) ?? null,
    totalMs: Date.now() - startedAt,
  };
}

async function invokeRenameThreadAgent(state: { inputPrompt?: string }, config?: RunnableConfig) {
  const startedAt = Date.now();
  const result = await renameThreadAgentNode(
    { messages: [new HumanMessage(state.inputPrompt ?? "")] },
    config as Parameters<typeof renameThreadAgentNode>[1],
  );
  return {
    lastMessage: result ?? null,
    totalMs: Date.now() - startedAt,
  };
}

async function invokeThreadSummarizeAgent(
  state: { inputPrompt?: string },
  config?: RunnableConfig,
) {
  const startedAt = Date.now();
  const result = await threadSummarizeNode(
    { messages: [new HumanMessage(state.inputPrompt ?? "")] },
    config as Parameters<typeof threadSummarizeNode>[1],
  );
  return {
    lastMessage: result ?? null,
    totalMs: Date.now() - startedAt,
  };
}

// ─── DB-side orchestration: write eval_run + paired observability
// ─── span, mirror what benchmark-runner.ts used to do in Next.js.
// ─── When this returns, state.runId is filled so judge can do its job
// ─── identically to the manual judge mode.

async function recordEvalRunNode(
  state: {
    targetAgent?: string;
    inputPrompt?: string;
    lastMessage?: unknown;
    totalMs?: number;
    dispatchAt?: number;
  },
  config?: RunnableConfig,
) {
  const userId =
    (config?.configurable?.userId as string | undefined) ??
    (config?.configurable?.user_id as string | undefined);
  if (!userId) {
    return { status: "failed", errorMessage: "userId missing from config" };
  }

  const targetAgent = state.targetAgent ?? "chatAgent";
  const totalMs = state.totalMs ?? (state.dispatchAt ? Date.now() - state.dispatchAt : 0);

  // ponytail: benchmark thread is hidden (kind=eval) — never
  // surfaces in the chat sidebar. Cleanup node deletes it after
  // judge finishes so it doesn't pile up; cascade deletes its spans.
  const benchmarkThreadId = randomUUID();
  const parentMessageId = `bm-${generateId()}`;
  await db
    .insert(threadTable)
    .values({
      id: benchmarkThreadId,
      userId,
      title: "Benchmark Run",
      kind: "eval",
    })
    .onConflictDoNothing();

  let errorMessage: string | null = null;
  try {
    const inserted = await recordEvalRunQuery({
      threadId: benchmarkThreadId,
      userId,
      agent: targetAgent,
      parentMessageId,
      totalMs,
      status: "success",
    });

    const spanRow: NewObservabilitySpanRow = {
      spanId: `bm-${inserted.id}`,
      parentSpanId: null,
      threadId: benchmarkThreadId,
      name: `benchmark:${targetAgent}`,
      kind: "chain",
      status: "completed",
      startedAt: (state.dispatchAt ?? Date.now()) - totalMs,
      endedAt: state.dispatchAt ?? Date.now(),
      input: { messages: [{ role: "user", content: state.inputPrompt ?? "" }] },
      output: (state.lastMessage ?? null) as never,
      usage: null,
      error: null,
      meta: {
        thread_id: benchmarkThreadId,
        parent_message_id: parentMessageId,
        benchmark_run_id: inserted.id,
      },
      parentMessageId,
    };
    await db.insert(observabilitySpans).values(spanRow).onConflictDoNothing();

    return {
      runId: inserted.id,
      benchmarkThreadId,
      parentMessageId,
      totalMs,
      status: "completed" as const,
    };
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
    return { status: "failed" as const, errorMessage };
  }
}

async function cleanupBenchmarkThread(state: {
  mode?: "judge" | "benchmark";
  benchmarkThreadId?: string;
}) {
  // Self-gating: judge mode never had a benchmark thread to delete,
  // benchmark mode does. No conditional edge needed upstream — the
  // node is reached unconditionally and decides on its own.
  if (state.mode !== "benchmark") return {};
  if (!state.benchmarkThreadId) return {};
  // Safe-fail cleanup — never blocks the run from completing.
  await db
    .delete(threadTable)
    .where(eq(threadTable.id, state.benchmarkThreadId))
    .catch(() => null);
  return {};
}

// ─── Judge node. Identical to the previous judge-only behavior; in
// ─── benchmark mode state.runId is now populated by recordEvalRun.

async function judgeNode(
  state: {
    runId?: string;
    rubricId?: string;
    benchmarkId?: string;
  },
  config?: RunnableConfig,
) {
  if (!state.runId) {
    return { status: "failed", errorMessage: "no runId to judge" };
  }
  const rubricId = state.rubricId ?? "rubric_default";
  const judgeThreadId = (config?.configurable?.thread_id as string) ?? null;
  const judgeParentMessageId = (config?.metadata?.parent_message_id as string) ?? null;

  // 1. Fetch run details
  const runs = await db.select().from(evalRun).where(eq(evalRun.id, state.runId)).limit(1);
  if (runs.length === 0) {
    return { status: "failed", errorMessage: `eval_run not found for id: ${state.runId}` };
  }
  const run = runs[0];

  // 2. Fetch rubric criteria directly by rubric_${run.agent} or rubricId
  const targetRubricId = `rubric_${run.agent}`;
  const rubrics = await db
    .select()
    .from(evalRubric)
    .where(eq(evalRubric.id, targetRubricId))
    .limit(1);
  const fallbackRubrics =
    rubrics.length > 0
      ? rubrics
      : await db.select().from(evalRubric).where(eq(evalRubric.id, rubricId)).limit(1);

  const rubric = fallbackRubrics[0] ?? {
    id: targetRubricId,
    name: `${run.agent} Evaluation Rubric`,
    criteria: [
      { key: "relevance", description: "Answer addresses user query accurately." },
      { key: "accuracy", description: "Answer is factually correct." },
    ],
  };

  // 3. Query conversation span context if parentMessageId exists
  let spanContext = "";
  if (run.parentMessageId) {
    const spans = await db
      .select({ input: observabilitySpans.input, output: observabilitySpans.output })
      .from(observabilitySpans)
      .where(
        and(
          eq(observabilitySpans.threadId, run.threadId),
          eq(observabilitySpans.parentMessageId, run.parentMessageId),
        ),
      )
      .limit(5);

    if (spans.length > 0) {
      spanContext =
        `\nConversation Trace Context:\n` +
        spans
          .map(
            (s, i) =>
              `Span ${i + 1}:\nInput: ${JSON.stringify(s.input)}\nOutput: ${JSON.stringify(s.output)}`,
          )
          .join("\n");
    }
  }

  try {
    const judgeModel = await getEvalModelFromDB();

    const criteriaFields = Object.fromEntries(
      rubric.criteria.map((c) => [
        c.key,
        z.number().min(1).max(5).describe(`Score 1-5 for ${c.key}: ${c.description}`),
      ]),
    );
    const dynamicJudgeSchema = z.object({
      ...criteriaFields,
      reasoning: z
        .string()
        .describe("Detailed reasoning explaining the score assignment for each criterion"),
    });

    const structuredModel = judgeModel.withStructuredOutput(dynamicJudgeSchema);

    const criteriaLines = rubric.criteria
      .map(
        (c) => `- ${c.key}${c.weight != null ? ` (weight: ${c.weight}%)` : ""}: ${c.description}`,
      )
      .join("\n");

    const prompt = `You are an expert AI Evaluator. Evaluate the quality of the AI Assistant's response to the User.

Evaluation Criteria (score each 1-5):
${criteriaLines}

Target Run ID: ${run.id}
Agent: ${run.agent}
Execution Duration: ${run.totalMs}ms
Status: ${run.status}
${spanContext}

Score each criterion on a scale of 1 to 5, and provide your overall reasoning.`;

    const result = await structuredModel.invoke(prompt);

    const scores: Record<string, number> = {};
    for (const c of rubric.criteria) {
      const val = (result as Record<string, unknown>)[c.key];
      if (typeof val === "number") scores[c.key] = val;
    }

    const judgmentId = await saveJudgment({
      runId: run.id,
      rubricId: rubric.id,
      scores,
      reasoning: (result as { reasoning: string }).reasoning,
      judgeThreadId,
      judgeParentMessageId,
    });

    // ponytail: in benchmark mode, denormalize the latest result onto
    // the benchmark row so the Benchmark Datasets surface can render
    // "Last Result" without joining eval_run + eval_judgment per render.
    // Weighted score uses the same formula as the frontend badge so the
    // numbers match. eval_judgment still owns score history; this is
    // just a snapshot of the most recent one. Concurrent Evaluate
    // clicks: last writer wins, which is fine for this UX.
    if (state.benchmarkId) {
      let weighted: number | null = null;
      let weightedSum = 0;
      let totalWeight = 0;
      for (const c of rubric.criteria) {
        const key = "key" in c ? c.key : (c as { name?: string }).name;
        const weight = c.weight ?? 0;
        const score = key ? scores[key] : undefined;
        if (!key || typeof score !== "number" || weight <= 0) continue;
        weightedSum += score * weight;
        totalWeight += weight;
      }
      if (totalWeight > 0) weighted = Math.round((weightedSum / totalWeight) * 100) / 100;

      await db
        .update(evalBenchmark)
        .set({
          latestJudgmentId: judgmentId,
          latestRunAt: new Date(),
          latestRunStatus: "completed",
          ...(weighted !== null ? { latestScore: Math.round(weighted * 20) } : {}),
        })
        .where(eq(evalBenchmark.id, state.benchmarkId))
        .catch(() => null);
    }

    return { status: "completed", errorMessage: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[evalAgent] Evaluation failed:", message);
    return { status: "failed", errorMessage: message };
  }
}

// ─── Routing functions (pure; exported for unit testing).
//
// ponytail: langgraph's `addConditionalEdges` path map is keyed on
// the EXACT value the routing function returns, not on the mode.
// Returning "judge"/"benchmark" (the mode discriminators) and
// mapping them to node names keeps the function return and the
// map keys aligned — eliminates "Branch condition returned unknown
// or null destination" mismatches.

export function routeByMode(state: { mode?: "judge" | "benchmark" }): "judge" | "benchmark" {
  return state.mode === "benchmark" ? "benchmark" : "judge";
}

type TargetNodeName =
  | "invokeChatAgent"
  | "invokeWeatherAgent"
  | "invokeCryptoAgent"
  | "invokeCodeAgent"
  | "invokeKbAgent"
  | "invokeRenameThreadAgent"
  | "invokeThreadSummarizeAgent";

type TargetAgentId =
  | "chatAgent"
  | "weatherAgent"
  | "cryptoAgent"
  | "codeAgent"
  | "kbAgent"
  | "renameThreadAgent"
  | "threadSummarizeAgent";

const TARGET_NODES: Record<TargetAgentId, TargetNodeName> = {
  chatAgent: "invokeChatAgent",
  weatherAgent: "invokeWeatherAgent",
  cryptoAgent: "invokeCryptoAgent",
  codeAgent: "invokeCodeAgent",
  kbAgent: "invokeKbAgent",
  renameThreadAgent: "invokeRenameThreadAgent",
  threadSummarizeAgent: "invokeThreadSummarizeAgent",
};

export function routeByTargetAgent(state: { targetAgent?: string }): TargetNodeName {
  const t = state.targetAgent as TargetAgentId | undefined;
  return t && t in TARGET_NODES ? TARGET_NODES[t] : "invokeChatAgent";
}

const builder = new StateGraph(EvalAgentState)
  // source/router nodes
  .addNode("inputRouter", inputRouter)
  .addNode("preDispatch", preDispatchNode)
  .addNode("benchmarkDispatch", benchmarkDispatch)
  // per-target invocation nodes
  .addNode("invokeChatAgent", invokeChatAgent)
  .addNode("invokeWeatherAgent", invokeWeatherAgent)
  .addNode("invokeCryptoAgent", invokeCryptoAgent)
  .addNode("invokeCodeAgent", invokeCodeAgent)
  .addNode("invokeKbAgent", invokeKbAgent)
  .addNode("invokeRenameThreadAgent", invokeRenameThreadAgent)
  .addNode("invokeThreadSummarizeAgent", invokeThreadSummarizeAgent)
  // orchestration nodes
  .addNode("recordEvalRun", recordEvalRunNode)
  .addNode("judge", judgeNode)
  .addNode("cleanupBenchmark", cleanupBenchmarkThread)
  .addEdge(START, "inputRouter")
  .addConditionalEdges("inputRouter", routeByMode, {
    judge: "judge",
    benchmark: "preDispatch",
  })
  .addEdge("preDispatch", "benchmarkDispatch")
  .addConditionalEdges("benchmarkDispatch", routeByTargetAgent, {
    invokeChatAgent: "invokeChatAgent",
    invokeWeatherAgent: "invokeWeatherAgent",
    invokeCryptoAgent: "invokeCryptoAgent",
    invokeCodeAgent: "invokeCodeAgent",
    invokeKbAgent: "invokeKbAgent",
    invokeRenameThreadAgent: "invokeRenameThreadAgent",
    invokeThreadSummarizeAgent: "invokeThreadSummarizeAgent",
  })
  // every target converges to recordEvalRun
  .addEdge("invokeChatAgent", "recordEvalRun")
  .addEdge("invokeWeatherAgent", "recordEvalRun")
  .addEdge("invokeCryptoAgent", "recordEvalRun")
  .addEdge("invokeCodeAgent", "recordEvalRun")
  .addEdge("invokeKbAgent", "recordEvalRun")
  .addEdge("invokeRenameThreadAgent", "recordEvalRun")
  .addEdge("invokeThreadSummarizeAgent", "recordEvalRun")
  .addEdge("recordEvalRun", "judge")
  .addEdge("judge", "cleanupBenchmark")
  .addEdge("cleanupBenchmark", END);

const standaloneCompiled = builder.compile({
  name: "evalAgent",
  checkpointer,
  store,
});

export const graph = standaloneCompiled.withConfig({
  callbacks: [capturingHandler, creditTrackingHandler],
});
