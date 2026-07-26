import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { evalRun, evalRubric } from "@/lib/eval/schema";
import { observabilitySpans } from "@/lib/observability/schema";
import { capturingHandler, creditTrackingHandler } from "@/backend/callbacks";
import { saveJudgment } from "@/lib/eval/queries";
import { getEvalModelFromDB } from "@/lib/provider/model-registry";
import { store } from "@/backend/store";
import { checkpointer } from "@/backend/checkpointer";

import type { RunnableConfig } from "@langchain/core/runnables";

export const EvalAgentState = new StateSchema({
  runId: z.string(),
  rubricId: z.string().default("rubric_default"),
  status: z.enum(["pending", "completed", "failed"]).default("pending"),
  errorMessage: z.string().nullable().default(null),
});

async function evaluateRunNode(
  state: {
    runId: string;
    rubricId?: string;
  },
  config?: RunnableConfig,
) {
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

  // 4. Obtain LLM Judge model
  try {
    const judgeModel = await getEvalModelFromDB();

    // Dynamically build the structured output schema from rubric.criteria
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

    // Collect all criterion scores dynamically (exclude 'reasoning' key)
    const scores: Record<string, number> = {};
    for (const c of rubric.criteria) {
      const val = (result as Record<string, unknown>)[c.key];
      if (typeof val === "number") scores[c.key] = val;
    }

    await saveJudgment({
      runId: run.id,
      rubricId: rubric.id,
      scores,
      reasoning: (result as { reasoning: string }).reasoning,
      judgeThreadId,
      judgeParentMessageId,
    });

    return { status: "completed", errorMessage: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[evalAgent] Evaluation failed:", message);
    return { status: "failed", errorMessage: message };
  }
}

const builder = new StateGraph(EvalAgentState)
  .addNode("evaluateAgent", evaluateRunNode)
  .addEdge(START, "evaluateAgent")
  .addEdge("evaluateAgent", END);

const standaloneCompiled = builder.compile({
  name: "evalAgent",
  checkpointer,
  store,
});

export const graph = standaloneCompiled.withConfig({
  callbacks: [capturingHandler, creditTrackingHandler],
});
