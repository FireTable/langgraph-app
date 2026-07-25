import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  promptTemplate,
  promptVariant,
  promptVariantAssignment,
  evalRun,
  evalFeedback,
  evalRubric,
  evalJudgment,
  type PromptTemplateRow,
  type PromptVariantRow,
  type EvalRunRow,
} from "@/lib/eval/schema";
import { generateId } from "@/lib/ids/nanoid";
import {
  CHAT_AGENT_PROMPT,
  ROUTER_AGENT_PROMPT,
  RENAME_THREAD_PROMPT,
  WEATHER_AGENT_PROMPT,
  CRYPTO_AGENT_PROMPT,
  CODE_AGENT_PROMPT,
  KB_OCR_PAGE_PROMPT,
  THREAD_SUMMARIZE_PROMPT,
  KB_ENTITY_EXTRACTION_SYSTEM_PROMPT,
  KB_ENTITY_ALIGNMENT_SYSTEM_PROMPT,
} from "@/backend/prompt/system";

function weightedPick<T extends { trafficWeight: number }>(items: T[]): T {
  const totalWeight = items.reduce((sum, item) => sum + Math.max(0, item.trafficWeight), 0);
  if (totalWeight <= 0) return items[0];
  let random = Math.random() * totalWeight;
  for (const item of items) {
    const w = Math.max(0, item.trafficWeight);
    if (random < w) return item;
    random -= w;
  }
  return items[items.length - 1];
}

/**
 * Seed initial System Prompts into DB if prompt_template is empty for an agent.
 * Idempotent — safe to run on every deploy / migration step.
 */

export async function seedInitialPrompts(): Promise<void> {
  const ALL_AGENT_PROMPTS: Record<string, string> = {
    chatAgent: CHAT_AGENT_PROMPT,
    routerAgent: ROUTER_AGENT_PROMPT,
    renameThreadAgent: RENAME_THREAD_PROMPT,
    weatherAgent: WEATHER_AGENT_PROMPT,
    cryptoAgent: CRYPTO_AGENT_PROMPT,
    codeAgent: CODE_AGENT_PROMPT,
    kbOcrAgent: KB_OCR_PAGE_PROMPT,
    threadSummarizeAgent: THREAD_SUMMARIZE_PROMPT,
    kbEntityExtractAgent: KB_ENTITY_EXTRACTION_SYSTEM_PROMPT,
    kbEntityAlignAgent: KB_ENTITY_ALIGNMENT_SYSTEM_PROMPT,
  };

  const GRAPH_MAPPING: Record<string, string> = {
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

  for (const [agentName, promptContent] of Object.entries(ALL_AGENT_PROMPTS)) {
    const groupName = GRAPH_MAPPING[agentName] ?? "agent";

    const existing = await db
      .select()
      .from(promptTemplate)
      .where(eq(promptTemplate.agent, agentName))
      .limit(1);

    if (existing.length === 0) {
      const tmplId = `tmpl_${agentName}_v1`;
      const varId = `var_${agentName}_default`;
      await db.insert(promptTemplate).values({
        id: tmplId,
        group: groupName,
        agent: agentName,
        content: promptContent,
        notes: `Initial system prompt v1 for ${agentName}`,
        userId: null,
      });
      await db.insert(promptVariant).values({
        id: varId,
        templateId: tmplId,
        label: "default",
        trafficWeight: 100,
        enabled: true,
      });
    } else {
      // Ensure existing records get updated with graph group name
      await db
        .update(promptTemplate)
        .set({ group: groupName })
        .where(eq(promptTemplate.agent, agentName));

      // Update existing control label to default
      await db
        .update(promptVariant)
        .set({ label: "default" })
        .where(
          and(eq(promptVariant.templateId, existing[0].id), eq(promptVariant.label, "control")),
        );
    }
  }

  const existingRubric = await db
    .select()
    .from(evalRubric)
    .where(eq(evalRubric.id, "rubric_default"))
    .limit(1);

  if (existingRubric.length === 0) {
    await db.insert(evalRubric).values({
      id: "rubric_default",
      name: "Default Agent Evaluation Rubric",
      criteria: [
        {
          key: "relevance",
          description: "Answer addresses user query accurately without missing key points.",
          weight: 0.5,
        },
        {
          key: "accuracy",
          description: "Answer is factually correct with no hallucinations.",
          weight: 0.5,
        },
      ],
    });
  }
}

/**
 * Assigns a prompt variant to a user for a given agent with sticky assignment.
 */
export async function assignPromptVariant(
  userId: string,
  agent: string,
): Promise<{ templateId: string; variantId: string; content: string }> {
  // 1. Check existing sticky assignment
  const assigned = await db
    .select({
      variantId: promptVariantAssignment.variantId,
      templateId: promptVariant.templateId,
      enabled: promptVariant.enabled,
      content: promptTemplate.content,
    })
    .from(promptVariantAssignment)
    .innerJoin(promptVariant, eq(promptVariantAssignment.variantId, promptVariant.id))
    .innerJoin(promptTemplate, eq(promptVariant.templateId, promptTemplate.id))
    .where(
      and(eq(promptVariantAssignment.userId, userId), eq(promptVariantAssignment.agent, agent)),
    )
    .limit(1);

  if (assigned.length > 0 && assigned[0].enabled) {
    return {
      templateId: assigned[0].templateId,
      variantId: assigned[0].variantId,
      content: assigned[0].content,
    };
  }

  // 2. Query available variants for this agent
  const candidates = await db
    .select({
      variantId: promptVariant.id,
      templateId: promptVariant.templateId,
      trafficWeight: promptVariant.trafficWeight,
      content: promptTemplate.content,
    })
    .from(promptVariant)
    .innerJoin(promptTemplate, eq(promptVariant.templateId, promptTemplate.id))
    .where(and(eq(promptTemplate.agent, agent), eq(promptVariant.enabled, true)));

  if (candidates.length === 0) {
    throw new Error(`No enabled prompt variants found for agent: ${agent}`);
  }

  const picked = weightedPick(candidates);

  // 3. Store sticky assignment (on conflict update to new pick if previous was disabled)
  await db
    .insert(promptVariantAssignment)
    .values({
      userId,
      agent,
      variantId: picked.variantId,
    })
    .onConflictDoUpdate({
      target: [promptVariantAssignment.userId, promptVariantAssignment.agent],
      set: { variantId: picked.variantId, updatedAt: new Date() },
    });

  return {
    templateId: picked.templateId,
    variantId: picked.variantId,
    content: picked.content,
  };
}

/**
 * Record an eval run for a completed turn.
 */
export async function recordEvalRun(data: {
  id?: string;
  threadId: string;
  userId: string;
  agent: string;
  templateId: string;
  variantId: string;
  branchId?: string | null;
  parentMessageId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalMs: number;
  status: string;
  errorMessage?: string | null;
  kbDocumentIds?: string[] | null;
}): Promise<EvalRunRow> {
  const id = data.id ?? generateId();
  const values = {
    id,
    threadId: data.threadId,
    userId: data.userId,
    agent: data.agent,
    templateId: data.templateId,
    variantId: data.variantId,
    branchId: data.branchId ?? null,
    parentMessageId: data.parentMessageId ?? null,
    inputTokens: data.inputTokens ?? null,
    outputTokens: data.outputTokens ?? null,
    totalMs: data.totalMs,
    status: data.status,
    errorMessage: data.errorMessage ?? null,
    kbDocumentIds: data.kbDocumentIds ?? null,
  };

  const inserted = await db.insert(evalRun).values(values).returning();
  return inserted[0];
}

/**
 * Record user or admin feedback on a run (rating 1..5).
 */
export async function submitFeedback(data: {
  runId: string;
  userId: string;
  source: string;
  rating: number;
  reason?: string | null;
}): Promise<void> {
  // Resolve actual runId if data.runId is a parentMessageId or assistant message ID
  const matchedRun = await db
    .select({ id: evalRun.id })
    .from(evalRun)
    .where(sql`${evalRun.id} = ${data.runId} OR ${evalRun.parentMessageId} = ${data.runId}`)
    .limit(1);

  const targetRunId = matchedRun[0]?.id ?? data.runId;
  const id = generateId();

  await db
    .insert(evalFeedback)
    .values({
      id,
      runId: targetRunId,
      userId: data.userId,
      source: data.source,
      rating: Math.min(5, Math.max(1, data.rating)),
      reason: data.reason ?? null,
    })
    .onConflictDoUpdate({
      target: [evalFeedback.userId, evalFeedback.runId],
      set: {
        source: data.source,
        rating: Math.min(5, Math.max(1, data.rating)),
        reason: data.reason ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Record LLM-as-a-Judge assessment for a run.
 */
export async function saveJudgment(data: {
  runId: string;
  rubricId: string;
  scores: Record<string, number>;
  reasoning?: string | null;
  totalCostTokens?: number | null;
}): Promise<void> {
  const id = generateId();
  await db.insert(evalJudgment).values({
    id,
    runId: data.runId,
    rubricId: data.rubricId,
    scores: data.scores,
    reasoning: data.reasoning ?? null,
    totalCostTokens: data.totalCostTokens ?? null,
  });
}
