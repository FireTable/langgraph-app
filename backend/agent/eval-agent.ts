import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { evalRun, evalRubric } from "@/lib/eval/schema";
import { observabilitySpans } from "@/lib/observability/schema";

import { saveJudgment } from "@/lib/eval/queries";
import { getEvalModelFromDB } from "@/lib/provider/model-registry";

export const EvalAgentState = new StateSchema({
  runId: z.string(),
  rubricId: z.string().default("rubric_default"),
  judgeThreadId: z.string().optional(),
  status: z.enum(["pending", "completed", "failed"]).default("pending"),
  errorMessage: z.string().nullable().default(null),
});

const JudgeSchema = z.object({
  relevance: z.number().describe("Score 1-5 for relevance to user prompt"),
  accuracy: z.number().describe("Score 1-5 for factual accuracy and correctness"),
  reasoning: z.string().describe("Detailed reasoning explaining the score assignment"),
});

async function evaluateRunNode(state: {
  runId: string;
  rubricId?: string;
  judgeThreadId?: string;
}) {
  const rubricId = state.rubricId ?? "rubric_default";

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
    const structuredModel = judgeModel.withStructuredOutput(JudgeSchema);

    const prompt = `You are an expert AI Evaluator. Evaluate the quality of the AI Assistant's response to the User.

Evaluation Criteria:
${JSON.stringify(rubric.criteria, null, 2)}

Target Run ID: ${run.id}
Agent: ${run.agent}
Execution Duration: ${run.totalMs}ms
Status: ${run.status}
${spanContext}

Evaluate relevance and accuracy on a scale of 1 to 5, and provide your reasoning.`;

    const result = await structuredModel.invoke(prompt);

    await saveJudgment({
      runId: run.id,
      rubricId: rubric.id,
      scores: {
        relevance: result.relevance,
        accuracy: result.accuracy,
      },
      reasoning: result.reasoning,
      judgeThreadId: state.judgeThreadId ?? null,
    });

    return { status: "completed", errorMessage: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[evalAgent] Evaluation failed:", message);
    return { status: "failed", errorMessage: message };
  }
}

const builder = new StateGraph(EvalAgentState)
  .addNode("evaluateRun", evaluateRunNode)
  .addEdge(START, "evaluateRun")
  .addEdge("evaluateRun", END);

export const graph = builder.compile();
