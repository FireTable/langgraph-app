import { pgEnum, pgTable, text, integer, numeric, timestamp, index } from "drizzle-orm/pg-core";
import { user } from "@/lib/auth/schema";

/**
 * Per-LLM-call outcome. Failed calls (status='error') still log so admins
 * see provider flakiness, but they're excluded from the cap SUM so users
 * don't pay for our 5xx.
 */
export const callStatus = pgEnum("call_status", ["success", "error"]);

/**
 * Append-only per-LLM-call log. Source of truth for:
 *   1. cap enforcement: SUM(credits) WHERE status='success' AND
 *      created_at >= now - role.windowHours hours
 *   2. user-facing call history
 *   3. provider/model-level spend analysis
 *
 * `updatedAt` lets backfill scripts (e.g. after a model rate correction)
 * identify which rows were touched. NOT meant for high-frequency updates
 * — see lib/credit/callback.ts for the write path.
 */
export const creditUsageLog = pgTable(
  "credit_usage_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(), // "openai" / "anthropic"
    modelName: text("model_name").notNull(), // "gpt-4o-mini"
    agentName: text("agent_name").notNull(), // "router" / "crypto" / "summarize" / ...
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    credits: numeric("credits", { precision: 12, scale: 4 }).notNull(),
    status: callStatus("status").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (t) => [
    // Cap check + history queries both walk (userId, createdAt) — this
    // composite index covers both with one B-tree.
    index("credit_usage_log_userId_createdAt_idx").on(t.userId, t.createdAt),
  ],
);
