import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  promptTemplate,
  promptVariant,
  promptVariantAssignment,
  evalRun,
  evalFeedback,
  evalRubric,
  evalJudgment,
  evalBenchmark,
  type PromptTemplateRow,
  type PromptVariantRow,
  type EvalRunRow,
  type EvalBenchmarkRow,
  type EvalJudgmentRow,
} from "@/lib/eval/schema";
import { generateId } from "@/lib/ids/nanoid";
import { threads as threadTable } from "@/lib/threads/schema";
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
  EVAL_JUDGE_SYSTEM_PROMPT,
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
    pageToMarkdown: KB_OCR_PAGE_PROMPT,
    threadSummarizeAgent: THREAD_SUMMARIZE_PROMPT,
    chunkExtract: KB_ENTITY_EXTRACTION_SYSTEM_PROMPT,
    chunkAlignment: KB_ENTITY_ALIGNMENT_SYSTEM_PROMPT,
    judgeByLLM: EVAL_JUDGE_SYSTEM_PROMPT,
  };

  const GRAPH_MAPPING: Record<string, string> = {
    chatAgent: "agent",
    routerAgent: "agent",
    weatherAgent: "agent",
    cryptoAgent: "agent",
    codeAgent: "agent",
    renameThreadAgent: "backgroundAgent",
    threadSummarizeAgent: "backgroundAgent",
    pageToMarkdown: "kbAgent",
    chunkExtract: "kbAgent",
    chunkAlignment: "kbAgent",
    judgeByLLM: "evalAgent",
  };

  for (const [agentName, promptContent] of Object.entries(ALL_AGENT_PROMPTS)) {
    const groupName = GRAPH_MAPPING[agentName] ?? "agent";

    // ponytail: every concurrent write here uses onConflictDoNothing so
    // multiple vitest workers (and any other racer — the seeder is
    // also called from /api/eval/prompts POST) can collide without
    // surfacing a duplicate-key error. The previous check-then-insert
    // pattern lost both writers' race in CI and left prompt_template
    // half-seeded, which then FK-violated eval_run inserts downstream.
    const tmplId = `tmpl_${agentName}_v1`;
    const varId = `var_${agentName}_default`;
    await db
      .insert(promptTemplate)
      .values({
        id: tmplId,
        group: groupName,
        agent: agentName,
        content: promptContent,
        notes: `Initial system prompt v1 for ${agentName}`,
        userId: null,
      })
      .onConflictDoNothing();
    await db
      .insert(promptVariant)
      .values({
        id: varId,
        templateId: tmplId,
        label: "default",
        trafficWeight: 100,
        enabled: true,
      })
      .onConflictDoNothing();

    // Ensure the seeded row stays in sync with the canonical graph
    // group name + variant label across deploys. UPDATEs are idempotent
    // so they don't need conflict guards.
    await db
      .update(promptTemplate)
      .set({ group: groupName })
      .where(eq(promptTemplate.agent, agentName));
    await db
      .update(promptVariant)
      .set({ label: "default" })
      .where(and(eq(promptVariant.templateId, tmplId), eq(promptVariant.label, "control")));

    // Seed the generic fallback rubric so "Run AI Judge" without a
    // per-agent rubric resolves to a real DB row instead of an in-memory
    // stub. Matches the hardcoded fallback in
    // backend/agent/eval-agent.ts and app/api/eval/judge/route.ts so the
    // judge sees identical criteria whether the row exists or not.
    const defaultRubricId = "rubric_default";
    const existingDefaultRubric = await db
      .select()
      .from(evalRubric)
      .where(eq(evalRubric.id, defaultRubricId))
      .limit(1);
    if (existingDefaultRubric.length === 0) {
      await db.insert(evalRubric).values({
        id: defaultRubricId,
        name: "Default Agent Evaluation Rubric",
        criteria: [
          {
            key: "relevance",
            description: "Answer addresses user query accurately.",
            weight: 0.5,
          },
          {
            key: "accuracy",
            description: "Answer is factually correct.",
            weight: 0.5,
          },
        ],
      });
    }

    // Seed agent-specific Rubrics (100% English, domain-tailored per Agent Node)
    const rubricId = `rubric_${agentName}`;
    const existingRubric = await db
      .select()
      .from(evalRubric)
      .where(eq(evalRubric.id, rubricId))
      .limit(1);

    if (existingRubric.length === 0) {
      const defaultCriteria: Record<
        string,
        Array<{ key: string; description: string; weight: number }>
      > = {
        chatAgent: [
          {
            key: "relevance",
            description: "Directness and helpfulness of response relative to user prompt.",
            weight: 0.5,
          },
          {
            key: "accuracy",
            description: "Factual correctness and absence of hallucination.",
            weight: 0.5,
          },
        ],
        routerAgent: [
          {
            key: "intent_precision",
            description: "Accuracy of classifying user query into correct domain sub-agent.",
            weight: 0.6,
          },
          {
            key: "routing_efficiency",
            description: "Speed and correctness of routing without superfluous steps.",
            weight: 0.4,
          },
        ],
        weatherAgent: [
          {
            key: "location_extraction",
            description: "Correct identification of target city and geographic region.",
            weight: 0.5,
          },
          {
            key: "forecast_completeness",
            description: "Inclusion of temperature, weather condition, and clothing advice.",
            weight: 0.5,
          },
        ],
        cryptoAgent: [
          {
            key: "market_data_accuracy",
            description: "Precision of live coin pricing, token symbols, and market metrics.",
            weight: 0.6,
          },
          {
            key: "financial_disclaimer",
            description: "Inclusion of appropriate risk disclosure for financial queries.",
            weight: 0.4,
          },
        ],
        codeAgent: [
          {
            key: "syntax_correctness",
            description: "Valid, runnable code snippet without syntax or type errors.",
            weight: 0.6,
          },
          {
            key: "logic_clarity",
            description: "Clear explanation of algorithm logic and edge-case handling.",
            weight: 0.4,
          },
        ],
        chunkExtract: [
          {
            key: "entity_completeness",
            description: "Extraction of all named domain entities from document chunks.",
            weight: 0.5,
          },
          {
            key: "relationship_precision",
            description: "Accurate graph relationship mapping between extracted entities.",
            weight: 0.5,
          },
        ],
        pageToMarkdown: [
          {
            key: "text_extraction_fidelity",
            description: "High accuracy OCR transcription from scanned pages or PDFs.",
            weight: 0.6,
          },
          {
            key: "layout_preservation",
            description: "Retention of tables, headers, and structural formatting.",
            weight: 0.4,
          },
        ],
        chunkAlignment: [
          {
            key: "alias_resolution",
            description: "Correct mapping of synonyms and acronyms to canonical entity nodes.",
            weight: 0.6,
          },
          {
            key: "deduplication_accuracy",
            description: "Successful merging of duplicate knowledge graph entities.",
            weight: 0.4,
          },
        ],
        renameThreadAgent: [
          {
            key: "title_conciseness",
            description: "Concise (3-6 word) title summarizing main conversation topic.",
            weight: 0.5,
          },
          {
            key: "semantic_relevance",
            description: "High capture rate of core user intent without conversational fluff.",
            weight: 0.5,
          },
        ],
        threadSummarizeAgent: [
          {
            key: "information_density",
            description: "Capture of key decisions, facts, and Q&As in compact bullet format.",
            weight: 0.6,
          },
          {
            key: "context_continuity",
            description: "Preservation of ongoing task goals across extended conversational turns.",
            weight: 0.4,
          },
        ],
        // ponytail: judgeByLLM is a scoring node, not a target — the
        // rubric here evaluates the quality of the judge's own output
        // (reasoning + scores), kept in DB so the Judge Eval Graph
        // surface has a populated Rubric tab matching every other agent.
        judgeByLLM: [
          {
            key: "criteria_alignment",
            description:
              "Scores across rubric criteria reflect genuine quality differences and match the criteria definitions.",
            weight: 0.4,
          },
          {
            key: "reasoning_clarity",
            description:
              "Reasoning explains the score with specific, actionable evidence drawn from the run output.",
            weight: 0.4,
          },
          {
            key: "calibration",
            description:
              "Scores span the 1-5 range appropriately rather than clustering around a default.",
            weight: 0.2,
          },
        ],
      };

      const criteria = defaultCriteria[agentName] ?? [
        { key: "relevance", description: "Answer addresses user query accurately.", weight: 0.5 },
        { key: "accuracy", description: "Answer is factually correct.", weight: 0.5 },
      ];

      await db.insert(evalRubric).values({
        id: rubricId,
        name: `${agentName} Evaluation Rubric`,
        criteria,
      });
    }

    // Seed agent-specific initial Benchmark Datasets (100% English)
    const existingBm = await db
      .select()
      .from(evalBenchmark)
      .where(eq(evalBenchmark.agent, agentName))
      .limit(1);

    if (existingBm.length === 0) {
      const defaultBenchmarks: Record<
        string,
        Array<{ title: string; inputPrompt: string; expectedOutput: string }>
      > = {
        chatAgent: [
          {
            title: "Basic Capability Overview",
            inputPrompt: "Hello! What capabilities can you assist me with today?",
            expectedOutput:
              "Polite assistant response summarizing support for general QA, weather queries, crypto market data, code assistance, and document search.",
          },
          {
            title: "Multi-step Reasoning Question",
            inputPrompt:
              "Compare the key trade-offs between Python and TypeScript for serverless microservices.",
            expectedOutput:
              "Balanced evaluation comparing Python cold-start & rich ecosystem vs TypeScript strong typing and V8 runtime performance.",
          },
        ],
        routerAgent: [
          {
            title: "Weather Intent Classification",
            inputPrompt: "Will I need an umbrella in Seattle tomorrow afternoon?",
            expectedOutput: "Accurately classifies intent and routes workflow to weatherAgent.",
          },
          {
            title: "Crypto Market Intent Classification",
            inputPrompt: "What is the current market price and 24h trading volume of Ethereum?",
            expectedOutput: "Accurately classifies intent and routes workflow to cryptoAgent.",
          },
          {
            title: "Code Assistance Routing",
            inputPrompt: "Write a TypeScript function to debounce rapid user input events.",
            expectedOutput: "Accurately classifies intent and routes workflow to codeAgent.",
          },
        ],
        weatherAgent: [
          {
            title: "City Weather Forecast Query",
            inputPrompt: "What is the weather forecast for Tokyo this weekend?",
            expectedOutput:
              "Executes get_weather tool and returns Tokyo temperature range, precipitation probability, and clothing advice.",
          },
        ],
        cryptoAgent: [
          {
            title: "Token Price & Metrics Query",
            inputPrompt: "Get me real-time price and market cap metrics for Bitcoin (BTC).",
            expectedOutput:
              "Executes crypto market tool and provides accurate pricing with a financial risk warning.",
          },
        ],
        codeAgent: [
          {
            title: "Algorithm Implementation",
            inputPrompt:
              "Implement a generic binary search algorithm in TypeScript with type parameters.",
            expectedOutput:
              "Provides clean, strongly-typed TypeScript code block with an O(log N) complexity explanation.",
          },
        ],
        chunkExtract: [
          {
            title: "Entity & Graph Relationship Extraction",
            inputPrompt:
              "OpenClaw is an open-source AI agent platform developed by the FireTable engineering team.",
            expectedOutput:
              "Extracts entities [OpenClaw (Product)], [FireTable (Organization)], [AI Agent Platform (Concept)] and maps relationships.",
          },
        ],
        pageToMarkdown: [
          {
            title: "Document OCR Processing",
            inputPrompt:
              "Extract clean Markdown text from uploaded quarterly financial report page 1.",
            expectedOutput:
              "Produces clean Markdown formatted text preserving tabular numbers and structural headers.",
          },
        ],
        chunkAlignment: [
          {
            title: "Entity Alias Resolution",
            inputPrompt: "Resolve 'BTC', 'Bitcoin', and 'XBT' against the knowledge graph.",
            expectedOutput:
              "Successfully aligns all three synonym aliases to the single canonical entity node 'Bitcoin'.",
          },
        ],
        renameThreadAgent: [
          {
            title: "Automatic Conversation Titling",
            inputPrompt: "Can you help me set up a Docker compose file for PostgreSQL and Redis?",
            expectedOutput: "Generates concise title: 'Docker Compose Setup for Postgres & Redis'.",
          },
        ],
        threadSummarizeAgent: [
          {
            title: "Conversation History Compression",
            inputPrompt: "Summarize the key architectural decisions made in the last 10 turns.",
            expectedOutput:
              "Bullet-point summary highlighting database schema choices, API contracts, and next action items.",
          },
        ],
        // ponytail: judgeByLLM is the scoring node; we still seed one
        // benchmark so the Judge Eval Graph Benchmark Datasets tab is
        // populated like every other agent. The benchmark's
        // inputPrompt documents a representative run to score; Run
        // Evaluate here records a chatAgent run (eval-agent's
        // routeFromInput falls back to invokeChatAgent when the target
        // isn't an invoke target) and then judgeByLLM scores it
        // against rubric_judgeByLLM.
        judgeByLLM: [
          {
            title: "Sample Run Scoring Calibration",
            inputPrompt:
              "Score a sample eval_run: chatAgent answered 'The capital of France is Paris' to user query 'What is the capital of France?' in 240ms.",
            expectedOutput:
              "Judge assigns criteria_alignment=5, reasoning_clarity=4, calibration=4 with reasoning citing the concise accurate response and noting the brief reasoning could include more context.",
          },
        ],
      };

      const bms = defaultBenchmarks[agentName] ?? [];
      for (const bm of bms) {
        const id = generateId();
        await db.insert(evalBenchmark).values({
          id,
          agent: agentName,
          title: bm.title,
          inputPrompt: bm.inputPrompt,
          expectedOutput: bm.expectedOutput,
        });
      }
    }
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

export async function recordEvalRun(data: {
  id?: string;
  threadId: string;
  userId: string;
  agent: string;
  templateId?: string;
  variantId?: string;
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

  let finalTemplateId = data.templateId;
  let finalVariantId = data.variantId;

  // Verify or resolve valid template_id and variant_id from DB for this agent
  if (
    !finalTemplateId ||
    !finalVariantId ||
    finalVariantId === "var_chat_default" ||
    finalVariantId.startsWith("fallback_")
  ) {
    const validVariant = await db
      .select({
        variantId: promptVariant.id,
        templateId: promptVariant.templateId,
      })
      .from(promptVariant)
      .innerJoin(promptTemplate, eq(promptVariant.templateId, promptTemplate.id))
      .where(and(eq(promptTemplate.agent, data.agent), eq(promptVariant.enabled, true)))
      .limit(1);

    if (validVariant.length > 0) {
      finalTemplateId = validVariant[0].templateId;
      finalVariantId = validVariant[0].variantId;
    } else {
      // Fallback to chatAgent default if target agent has no custom variant
      const chatVariant = await db
        .select({
          variantId: promptVariant.id,
          templateId: promptVariant.templateId,
        })
        .from(promptVariant)
        .where(eq(promptVariant.id, "var_chat_control"))
        .limit(1);

      if (chatVariant.length > 0) {
        finalTemplateId = chatVariant[0].templateId;
        finalVariantId = chatVariant[0].variantId;
      }
    }
  }

  const values = {
    id,
    threadId: data.threadId,
    userId: data.userId,
    agent: data.agent,
    templateId: finalTemplateId!,
    variantId: finalVariantId!,
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
  // ponytail: chat UI sends the assistant message id (`resp_...`); resolve
  // to the eval_run row that owns that message via parent_message_id.
  // When the callback never recorded a run for this turn (eval tables
  // disabled, callback mis-wired, or synthetic dev traffic) there is
  // nothing to rate — return success so the thumbs-up button silently
  // no-ops instead of crashing the chat on a dangling FK violation.
  const matchedRun = await db
    .select({ id: evalRun.id })
    .from(evalRun)
    .where(sql`${evalRun.id} = ${data.runId} OR ${evalRun.parentMessageId} = ${data.runId}`)
    .limit(1);

  const targetRunId = matchedRun[0]?.id;
  if (!targetRunId) return;

  await db
    .insert(evalFeedback)
    .values({
      id: generateId(),
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
  judgeThreadId?: string | null;
  judgeParentMessageId?: string | null;
}): Promise<string> {
  const id = generateId();
  await db.insert(evalJudgment).values({
    id,
    runId: data.runId,
    rubricId: data.rubricId,
    scores: data.scores,
    reasoning: data.reasoning ?? null,
    totalCostTokens: data.totalCostTokens ?? null,
    judgeThreadId: data.judgeThreadId ?? null,
    judgeParentMessageId: data.judgeParentMessageId ?? null,
  });
  return id;
}

/**
 * Update Rubric criteria for a given rubric ID.
 */
export async function updateRubricCriteria(data: {
  rubricId: string;
  name?: string;
  criteria: Array<{ key: string; description: string; weight?: number }>;
}): Promise<void> {
  await db
    .insert(evalRubric)
    .values({
      id: data.rubricId,
      name: data.name ?? "Custom Agent Evaluation Rubric",
      criteria: data.criteria,
    })
    .onConflictDoUpdate({
      target: evalRubric.id,
      set: {
        ...(data.name ? { name: data.name } : {}),
        criteria: data.criteria,
        updatedAt: new Date(),
      },
    });
}

/**
 * Benchmark Dataset Queries
 */
export async function createBenchmark(data: {
  agent: string;
  title: string;
  inputPrompt: string;
  expectedOutput?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const id = generateId();
  const [inserted] = await db
    .insert(evalBenchmark)
    .values({
      id,
      agent: data.agent,
      title: data.title,
      inputPrompt: data.inputPrompt,
      expectedOutput: data.expectedOutput ?? null,
      metadata: data.metadata ?? null,
    })
    .returning();
  return inserted;
}

export async function getAllBenchmarks() {
  return await db.select().from(evalBenchmark).orderBy(evalBenchmark.createdAt);
}

// ponytail: each benchmark row is denormalized with the latest
// eval_judgment fields so the Benchmark Datasets table can render
// "Last Result" (AI Judge Assessment + Activity trace) without
// per-render joins. Cursor is benchmark.latest_judgment_id; LEFT JOIN
// keeps new cases without a judgment in the response with judgment=null.
export type BenchmarkWithLatestJudgment = EvalBenchmarkRow & {
  judgment: Pick<
    EvalJudgmentRow,
    "id" | "scores" | "reasoning" | "judgeThreadId" | "judgeParentMessageId" | "createdAt"
  > | null;
};

export async function getAllBenchmarksWithLatestJudgment(): Promise<BenchmarkWithLatestJudgment[]> {
  const rows = await db
    .select({
      bm: evalBenchmark,
      j: {
        id: evalJudgment.id,
        scores: evalJudgment.scores,
        reasoning: evalJudgment.reasoning,
        judgeThreadId: evalJudgment.judgeThreadId,
        judgeParentMessageId: evalJudgment.judgeParentMessageId,
        createdAt: evalJudgment.createdAt,
      },
    })
    .from(evalBenchmark)
    .leftJoin(evalJudgment, eq(evalJudgment.id, evalBenchmark.latestJudgmentId))
    .orderBy(evalBenchmark.createdAt);

  return rows.map((r) => {
    const j = r.j;
    return {
      ...r.bm,
      judgment: j && j.id ? j : null,
    };
  });
}

export async function deleteBenchmark(id: string) {
  await db.delete(evalBenchmark).where(eq(evalBenchmark.id, id));
}

/**
 * Fetch a single page of eval_run rows for one agent, newest first. The
 * cursor is the id of the last row from the previous page; the function
 * resolves it to its createdAt and returns rows strictly older than that
 * point (tie-broken on id DESC so paginated walks are stable even when
 * rows share a timestamp). fetched_limit + 1 → hasMore + nextCursorId.
 */
export type RecentRunRow = {
  id: string;
  agent: string;
  variantId: string;
  label: string | null;
  totalMs: number;
  status: string;
  createdAt: Date;
  userRating: number | null;
  threadId: string;
  parentMessageId: string | null;
};

export async function getRunsByAgentPage(args: {
  agent: string;
  cursorId?: string | null;
  limit: number;
}): Promise<{
  runs: RecentRunRow[];
  hasMore: boolean;
  nextCursorId: string | null;
}> {
  const { agent, cursorId, limit } = args;
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 5));

  // ponytail: read the cursor row's `created_at` as a PG-rendered
  // string (microsecond-precise) instead of a JS Date (truncated to
  // millisecond). PG's `timestamptz` is microsecond-precise on disk,
  // but Drizzle hydrates it to `Date` which only carries milliseconds
  // — when that truncated value is fed back into the next query's
  // `lt(createdAt, ?)`, sibling rows whose PG `created_at` differs
  // from the cursor by sub-millisecond get re-classified to the
  // wrong side of the cursor and the page silently drops rows. The
  // test that caught this (`paginates newest-first per agent with
  // stable hasMore + cursor`) inserts 7 rows in tight succession
  // and depends on the cursor rounding down to the exact PG value.
  let cursorCreatedAtRaw: string | null = null;
  if (cursorId) {
    const rows = await db
      .select({ createdAt: sql<string>`${evalRun.createdAt}::text` })
      .from(evalRun)
      .where(eq(evalRun.id, cursorId))
      .limit(1);
    cursorCreatedAtRaw = rows[0]?.createdAt ?? null;
  }

  // ponytail: only NON-benchmark runs surface in Online Executions.
  // Benchmark runs write threads.kind='eval-benchmark'; judge scoring
  // runs write kind='eval-judge' — those surface here so the Judge
  // Eval Graph card has real data. Chat + KB ingest threads are also
  // included (`chat` = user chat flow, `kb` = standalone kbAgent
  // ingestion) so the per-agent Online Executions card reflects
  // everything that actually ran in production. Earlier `kind='chat'`
  // and `kind!='eval'` filters were both too coarse — chat-only hid
  // every KB ingest run; `!='eval'` accidentally hid judge scoring
  // too. The cursor lookup below uses the same guard. The cursor
  // itself uses PG row-value comparison on (created_at, id) so the
  // microsecond precision from the raw string above is preserved end
  // to end — no JS Date round-trip.
  const notEvalKind = ne(threadTable.kind, "eval-benchmark");
  const whereClause =
    cursorCreatedAtRaw && cursorId
      ? and(
          eq(evalRun.agent, agent),
          notEvalKind,
          sql`(${evalRun.createdAt}, ${evalRun.id}) < (${cursorCreatedAtRaw}::timestamptz, ${cursorId})`,
        )
      : and(eq(evalRun.agent, agent), notEvalKind);

  const rows = await db
    .select({
      id: evalRun.id,
      agent: evalRun.agent,
      variantId: evalRun.variantId,
      label: promptVariant.label,
      totalMs: evalRun.totalMs,
      status: evalRun.status,
      createdAt: evalRun.createdAt,
      userRating: evalFeedback.rating,
      threadId: evalRun.threadId,
      parentMessageId: evalRun.parentMessageId,
    })
    .from(evalRun)
    .innerJoin(threadTable, eq(threadTable.id, evalRun.threadId))
    .leftJoin(promptVariant, eq(evalRun.variantId, promptVariant.id))
    .leftJoin(evalFeedback, eq(evalRun.id, evalFeedback.runId))
    .where(whereClause)
    .orderBy(sql`${evalRun.createdAt} DESC, ${evalRun.id} DESC`)
    .limit(safeLimit + 1);

  const hasMore = rows.length > safeLimit;
  const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
  const nextCursorId = hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null;

  const runs: RecentRunRow[] = pageRows.map((r) => ({
    id: r.id,
    agent: r.agent,
    variantId: r.variantId,
    label: r.label,
    totalMs: r.totalMs,
    status: r.status,
    createdAt: r.createdAt,
    userRating: r.userRating,
    threadId: r.threadId,
    parentMessageId: r.parentMessageId,
  }));

  return { runs, hasMore, nextCursorId };
}
