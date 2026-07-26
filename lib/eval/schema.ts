import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "@/lib/auth/schema";
import { threads } from "@/lib/threads/schema";

export const promptTemplate = pgTable(
  "prompt_template",
  {
    id: text("id").primaryKey(),
    group: text("group").notNull().default("Main Assistant"),
    agent: text("agent").notNull(),
    content: text("content").notNull(),
    notes: text("notes"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("prompt_template_agent_idx").on(t.agent)],
);

export const promptVariant = pgTable(
  "prompt_variant",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => promptTemplate.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    trafficWeight: integer("traffic_weight").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("prompt_variant_template_idx").on(t.templateId)],
);

export const promptVariantAssignment = pgTable(
  "prompt_variant_assignment",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    variantId: text("variant_id")
      .notNull()
      .references(() => promptVariant.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.agent] })],
);

export const evalRun = pgTable(
  "eval_run",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    templateId: text("template_id")
      .notNull()
      .references(() => promptTemplate.id),
    variantId: text("variant_id")
      .notNull()
      .references(() => promptVariant.id),
    branchId: text("branch_id"),
    parentMessageId: text("parent_message_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalMs: integer("total_ms").notNull(),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    kbDocumentIds: text("kb_document_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("eval_run_user_idx").on(t.userId),
    index("eval_run_variant_idx").on(t.variantId),
    index("eval_run_thread_idx").on(t.threadId),
    index("eval_run_parent_message_idx").on(t.parentMessageId),
    index("eval_run_created_idx").on(t.createdAt),
  ],
);

export const evalFeedback = pgTable(
  "eval_feedback",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => evalRun.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    rating: integer("rating").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("eval_feedback_run_idx").on(t.runId),
    uniqueIndex("eval_feedback_user_run_idx").on(t.userId, t.runId),
  ],
);

export const evalRubric = pgTable("eval_rubric", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  criteria: jsonb("criteria")
    .$type<Array<{ key: string; description: string; weight?: number }>>()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const evalJudgment = pgTable(
  "eval_judgment",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => evalRun.id, { onDelete: "cascade" }),
    rubricId: text("rubric_id")
      .notNull()
      .references(() => evalRubric.id),
    scores: jsonb("scores").$type<Record<string, number>>().notNull(),
    reasoning: text("reasoning"),
    totalCostTokens: integer("total_cost_tokens"),
    judgeThreadId: text("judge_thread_id"),
    judgeParentMessageId: text("judge_parent_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("eval_judgment_run_idx").on(t.runId)],
);

export const evalBenchmark = pgTable(
  "eval_benchmark",
  {
    id: text("id").primaryKey(),
    agent: text("agent").notNull(),
    title: text("title").notNull(),
    inputPrompt: text("input_prompt").notNull(),
    expectedOutput: text("expected_output"),
    metadata: jsonb("metadata").$type<{
      tags?: string[];
      kbDocumentIds?: string[];
      [key: string]: unknown;
    }>(),
    // ponytail: denormalized pointer + scoring snapshot so Benchmark
    // Datasets can render "Last Result" without joining eval_run /
    // eval_judgment per-render. eval_judgment still owns the score
    // history; this just points at the most recent one. last writer
    // wins on concurrent Evaluate clicks.
    latestJudgmentId: text("latest_judgment_id"),
    latestRunAt: timestamp("latest_run_at", { withTimezone: true }),
    latestRunStatus: text("latest_run_status"),
    latestScore: integer("latest_score"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("eval_benchmark_agent_idx").on(t.agent)],
);

export type PromptTemplateRow = typeof promptTemplate.$inferSelect;
export type PromptVariantRow = typeof promptVariant.$inferSelect;
export type PromptVariantAssignmentRow = typeof promptVariantAssignment.$inferSelect;
export type EvalRunRow = typeof evalRun.$inferSelect;
export type EvalFeedbackRow = typeof evalFeedback.$inferSelect;
export type EvalRubricRow = typeof evalRubric.$inferSelect;
export type EvalJudgmentRow = typeof evalJudgment.$inferSelect;
export type EvalBenchmarkRow = typeof evalBenchmark.$inferSelect;
export type NewEvalBenchmarkRow = typeof evalBenchmark.$inferInsert;
