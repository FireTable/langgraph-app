import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { lastHumanMessageId } from "@/lib/langgraph/last-human-message-id";
import { recordEvalRun } from "@/lib/eval/queries";

type InFlightRun = {
  startedAt: number;
  parentRunId: string | null;
  parentMessageId: string | null;
  threadId: string | null;
  userId: string | null;
  templateId: string;
  variantId: string;
  inputTokens: number;
  outputTokens: number;
  name: string;
};

export class EvalCallbackHandler extends BaseCallbackHandler {
  name = "eval_callback";
  private runs = new Map<string, InFlightRun>();

  handleChainStart(
    chain: Serialized,
    inputs: Record<string, unknown>,
    runId: string,
    _runType?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    parentRunId?: string,
  ) {
    const metaPmid = metadata?.parent_message_id;
    const fromMessages = lastHumanMessageId((inputs as { messages?: unknown }).messages);
    const parentMessageId =
      typeof metaPmid === "string" && metaPmid.length > 0 ? metaPmid : fromMessages;

    const meta = (metadata ?? {}) as Record<string, any>;
    const configurable = (meta.configurable ?? {}) as Record<string, any>;

    const threadId =
      (meta.thread_id as string) ??
      (meta.threadId as string) ??
      (configurable.thread_id as string) ??
      (configurable.threadId as string) ??
      null;
    const userId =
      (meta.user_id as string) ??
      (meta.userId as string) ??
      (configurable.user_id as string) ??
      (configurable.userId as string) ??
      null;
    const templateId =
      (meta.templateId as string) ?? (configurable.templateId as string) ?? "tmpl_chat_v1";
    const variantId =
      (meta.variantId as string) ?? (configurable.variantId as string) ?? "var_chat_default";

    // Track the chain name (e.g. mainAgent, chatAgent, routerAgent)
    const name = runName ?? chain.id?.[chain.id.length - 1] ?? "agent";

    this.runs.set(runId, {
      startedAt: Date.now(),
      parentRunId: parentRunId ?? null,
      parentMessageId,
      threadId,
      userId,
      templateId,
      variantId,
      inputTokens: 0,
      outputTokens: 0,
      name,
    });
  }

  handleLLMEnd(output: LLMResult, runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    const usage = output.llmOutput?.tokenUsage as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;
    if (usage) {
      run.inputTokens += usage.promptTokens ?? 0;
      run.outputTokens += usage.completionTokens ?? 0;
    }
  }

  async handleChainEnd(_outputs: Record<string, unknown>, runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;

    // Record when it is root chain OR an agent chain (like mainAgent, chatAgent)
    const isTargetAgent =
      run.parentRunId === null ||
      ["mainAgent", "chatAgent", "routerAgent", "kbAgent"].includes(run.name);

    if (isTargetAgent) {
      const endedAt = Date.now();
      const totalMs = Math.max(1, endedAt - run.startedAt);

      // Fallback threadId & userId for single-user dev testing if missing
      const finalThreadId = run.threadId || "dev-thread";
      const finalUserId = run.userId || "dev-user";

      try {
        await recordEvalRun({
          threadId: finalThreadId,
          userId: finalUserId,
          agent: run.name || "chatAgent",
          templateId: run.templateId,
          variantId: run.variantId,
          parentMessageId: run.parentMessageId,
          inputTokens: run.inputTokens || null,
          outputTokens: run.outputTokens || null,
          totalMs,
          status: "success",
        });
        console.log(`[EvalCallbackHandler] Recorded eval_run for ${run.name} (${runId})`);
      } catch (err) {
        console.error("[EvalCallbackHandler] Error recording eval run:", err);
      }
    }

    this.runs.delete(runId);
  }

  handleChainError(error: Error, runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;

    const isTargetAgent =
      run.parentRunId === null ||
      ["mainAgent", "chatAgent", "routerAgent", "kbAgent"].includes(run.name);

    if (isTargetAgent) {
      const endedAt = Date.now();
      const totalMs = Math.max(1, endedAt - run.startedAt);
      const finalThreadId = run.threadId || "dev-thread";
      const finalUserId = run.userId || "dev-user";

      recordEvalRun({
        threadId: finalThreadId,
        userId: finalUserId,
        agent: run.name || "chatAgent",
        templateId: run.templateId,
        variantId: run.variantId,
        parentMessageId: run.parentMessageId,
        inputTokens: run.inputTokens || null,
        outputTokens: run.outputTokens || null,
        totalMs,
        status: "error",
        errorMessage: error.message,
      }).catch((err) => {
        console.error("[EvalCallbackHandler] Error recording failed eval run:", err);
      });
    }

    this.runs.delete(runId);
  }
}
