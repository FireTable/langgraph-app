import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { creditUsageLog } from "./schema";

export type RecordLlmCallInput = {
  userId: string;
  providerId: string;
  modelName: string;
  agentName: string;
  usage: { input: number; output: number };
  status: "success" | "error";
  errorMessage?: string;
};

// UUIDs (not nanoid) — threads/queries.ts already notes the project
// convention; keeps credit_usage_log aligned with every other table's
// row id format.
export async function recordLlmCall(
  input: RecordLlmCallInput & { credits: number },
): Promise<void> {
  await db.insert(creditUsageLog).values({
    id: randomUUID(),
    userId: input.userId,
    providerId: input.providerId,
    modelName: input.modelName,
    agentName: input.agentName,
    inputTokens: input.usage.input,
    outputTokens: input.usage.output,
    credits: String(input.credits),
    status: input.status,
    errorMessage: input.errorMessage,
  });
}

// Pure credit math, separated so it's trivially unit-testable without
// a DB. Pass provider.model rate config in directly.
export function computeCredits(
  usage: { input: number; output: number },
  rate: { inputPer1k: number; outputPer1k: number },
): number {
  return (usage.input / 1000) * rate.inputPer1k + (usage.output / 1000) * rate.outputPer1k;
}
