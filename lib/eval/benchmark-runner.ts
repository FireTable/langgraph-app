import { eq } from "drizzle-orm";
import { HumanMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { evalBenchmark } from "@/lib/eval/schema";
import { threads as threadTable } from "@/lib/threads/schema";
import { graph as agentGraph } from "@/backend/agent";
import { graph as backgroundGraph } from "@/backend/background-agent";
import { graph as kbGraph } from "@/backend/agent/kb-agent";
import { getEvalModelFromDB } from "@/lib/provider/model-registry";
import { langGraphClient } from "@/lib/langgraph/client";
import { generateId } from "@/lib/ids/nanoid";
import { observabilitySpans, type NewObservabilitySpanRow } from "@/lib/observability/schema";
import { recordEvalRun } from "@/lib/eval/queries";

const GRAPH_MAPPING: Record<string, "agent" | "background_agent" | "kbAgent"> = {
  chatAgent: "agent",
  routerAgent: "agent",
  weatherAgent: "agent",
  cryptoAgent: "agent",
  codeAgent: "agent",
  renameThreadAgent: "background_agent",
  threadSummarizeAgent: "background_agent",
  kbOcrAgent: "kbAgent",
  kbEntityExtractAgent: "kbAgent",
  kbEntityAlignAgent: "kbAgent",
};

export class BenchmarkNotFoundError extends Error {
  constructor() {
    super("BENCHMARK_NOT_FOUND");
    this.name = "BenchmarkNotFoundError";
  }
}

function resolveGraph(agent: string) {
  const target = GRAPH_MAPPING[agent];
  if (target === "background_agent") return backgroundGraph;
  if (target === "kbAgent") return kbGraph;
  // ponytail: agent covers all "user-facing" sub-agents — chat /
  // router / weather / crypto / code. Router is the entry point so a
  // benchmark tagged as routerAgent still routes end-to-end.
  return agentGraph;
}

async function createBenchmarkThread(userId: string): Promise<string> {
  const threadId = randomUUID();
  await db
    .insert(threadTable)
    .values({ id: threadId, userId, title: "Benchmark Run", kind: "eval" })
    .onConflictDoNothing();
  return threadId;
}

async function registerThreadWithClient(threadId: string): Promise<void> {
  try {
    await langGraphClient.threads.create({ threadId, ifExists: "do_nothing" });
  } catch {
    // local dev server without langgraph server
  }
}

export async function runBenchmark(args: { benchmarkId: string; userId: string }): Promise<{
  runId: string;
  threadId: string;
  judgeThreadId: string;
  result: { status: string; errorMessage: string | null };
}> {
  const rows = await db
    .select()
    .from(evalBenchmark)
    .where(eq(evalBenchmark.id, args.benchmarkId))
    .limit(1);
  if (rows.length === 0) throw new BenchmarkNotFoundError();
  const benchmark = rows[0]!;

  const threadId = await createBenchmarkThread(args.userId);
  await registerThreadWithClient(threadId);

  const messageId = `bm-${generateId()}`;
  const startedAt = Date.now();

  const graph = resolveGraph(benchmark.agent);

  const agentRunId = randomUUID();
  let lastMessage: unknown = null;
  let errorMessage: string | null = null;
  try {
    const result = await graph.invoke(
      { messages: [new HumanMessage({ id: messageId, content: benchmark.inputPrompt })] },
      {
        configurable: { thread_id: threadId, user_id: args.userId, userId: args.userId },
        metadata: {
          run_id: agentRunId,
          parent_message_id: messageId,
          thread_id: threadId,
          user_id: args.userId,
        },
      },
    );
    const resultMessages = (result as { messages?: unknown[] }).messages;
    if (Array.isArray(resultMessages) && resultMessages.length > 0) {
      lastMessage = resultMessages[resultMessages.length - 1];
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const totalMs = Math.max(1, Date.now() - startedAt);

  // ponytail: route through recordEvalRun so the template/variant
  // fallback chain (rubric_${agent} → var_chat_control → default)
  // resolves against the actual seeded prompt_variant rows. Hardcoding
  // the IDs here blew up on FK violation against the seeded IDs
  // (var_chatAgent_default, etc.) — discovered during the live
  // integration test on 2026-07-26.
  const runRow = await recordEvalRun({
    threadId,
    userId: args.userId,
    agent: benchmark.agent,
    parentMessageId: messageId,
    totalMs,
    status: errorMessage ? "error" : "success",
    errorMessage,
  });
  const runId = runRow.id;

  // ponytail: stamp the assistant output (or error) into the spans
  // table so the judge has access to the model's reply without
  // re-deriving it from the LLM log. The metric is intentionally
  // minimal — when observability spans already cover this thread the
  // panel surfaces them; for benchmarks the route doesn't open a
  // visible thread, so a single paired span is the ground truth.
  await persistBenchmarkOutput({
    runId,
    threadId,
    parentMessageId: messageId,
    agent: benchmark.agent,
    input: benchmark.inputPrompt,
    output: lastMessage,
    errorMessage,
    totalMs,
  });

  const judgeThreadId = randomUUID();
  const judgeParentMessageId = randomUUID();
  await db
    .insert(threadTable)
    .values({ id: judgeThreadId, userId: args.userId, title: "AI Judge Run", kind: "eval" })
    .onConflictDoNothing();
  await registerThreadWithClient(judgeThreadId);

  const input = {
    runId,
    rubricId: `rubric_${benchmark.agent}`,
  };

  const config = {
    configurable: {
      userId: args.userId,
      thread_id: judgeThreadId,
      user_id: args.userId,
    },
  };

  const metadata = {
    parent_message_id: judgeParentMessageId,
    thread_id: judgeThreadId,
    user_id: args.userId,
  };

  // ponytail: dispatch the judge through the LangGraph dev server (port
  // 2024) via runs.wait — same pattern as app/api/eval/judge/route.ts.
  // In-process evalAgentGraph.invoke skips the dev server's checkpointer
  // and store, which the evaluateRunNode reads for thread/parent message
  // context. Going through the dev server keeps the judge trace visible
  // in the observability panel and matches the existing judge route.
  const judgeResult = (await langGraphClient.runs.wait(judgeThreadId, "evalAgent", {
    input,
    config,
    metadata,
  })) as { status?: string; errorMessage?: string | null } | undefined;

  // ponytail: make sure the eval model cache is warm so subsequent
  // judge runs don't repeat the registry lookup. Failure here is
  // non-fatal — the judge already succeeded above.
  await getEvalModelFromDB().catch(() => null);

  // ponytail: clean up the benchmark's hidden thread row so it doesn't
  // pile up in the DB. Spans cascade-delete with it. The agent
  // checkpointer keeps a stale copy under the same id, but the
  // benchmark row in `threads` is what the user sees in the sidebar
  // (kind='kb' filter excludes it anyway).
  await db
    .delete(threadTable)
    .where(eq(threadTable.id, threadId))
    .catch(() => null);

  return {
    runId,
    threadId,
    judgeThreadId,
    result: {
      status:
        ((judgeResult as { status?: string })?.status ?? errorMessage) ? "failed" : "completed",
      errorMessage: (judgeResult as { errorMessage?: string | null })?.errorMessage ?? null,
    },
  };
}

async function persistBenchmarkOutput(args: {
  runId: string;
  threadId: string;
  parentMessageId: string;
  agent: string;
  input: string;
  output: unknown;
  errorMessage: string | null;
  totalMs: number;
}): Promise<void> {
  const now = Date.now();
  const row: NewObservabilitySpanRow = {
    spanId: `bm-${args.runId}`,
    parentSpanId: null,
    threadId: args.threadId,
    name: `benchmark:${args.agent}`,
    kind: "chain",
    status: args.errorMessage ? "failed" : "completed",
    startedAt: now - args.totalMs,
    endedAt: now,
    input: { messages: [{ role: "user", content: args.input }] },
    output: (args.output ?? null) as never,
    usage: null,
    error: args.errorMessage,
    meta: {
      thread_id: args.threadId,
      parent_message_id: args.parentMessageId,
      benchmark_run_id: args.runId,
    },
    parentMessageId: args.parentMessageId,
  };
  await db.insert(observabilitySpans).values(row).onConflictDoNothing();
}
