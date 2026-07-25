import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import { lastHumanMessageId } from "@/lib/langgraph/last-human-message-id";
import { recordEvalRun } from "@/lib/eval/queries";

type InFlightLLMRun = {
  startedAt: number;
  threadId: string | null;
  userId: string | null;
  templateId: string;
  variantId: string;
  agent: string;
  parentMessageId: string | null;
};

export class EvalCallbackHandler extends BaseCallbackHandler {
  name = "eval_callback";
  private runs = new Map<string, InFlightLLMRun>();

  /**
   * Native LangChain callback for LLM / ChatModel invocations.
   * Naturally ignores all internal graph nodes (RunnableSequence, RunnableLambda, etc.)
   */
  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    const meta = (metadata ?? {}) as Record<string, any>;
    const configurable = (meta.configurable ?? {}) as Record<string, any>;

    const metaPmid = meta.parent_message_id as string | undefined;
    const fromMessages = lastHumanMessageId(messages?.[0]);
    const parentMessageId =
      typeof metaPmid === "string" && metaPmid.length > 0 ? metaPmid : fromMessages;

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

    // Standard LangGraph metadata: langgraph_node is auto-injected by the LangGraph engine
    const agent =
      (meta.langgraph_node as string) ??
      (meta.langgraph_checkpoint_ns as string)?.split(":").pop() ??
      runName ??
      "chatAgent";

    this.runs.set(runId, {
      startedAt: Date.now(),
      threadId,
      userId,
      templateId,
      variantId,
      agent,
      parentMessageId,
    });
  }

  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
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

    const agent =
      (meta.langgraph_node as string) ?? runName ?? llm.id?.[llm.id.length - 1] ?? "chatAgent";

    this.runs.set(runId, {
      startedAt: Date.now(),
      threadId,
      userId,
      templateId:
        (meta.templateId as string) ?? (configurable.templateId as string) ?? "tmpl_chat_v1",
      variantId:
        (meta.variantId as string) ?? (configurable.variantId as string) ?? "var_chat_default",
      agent,
      parentMessageId: (meta.parent_message_id as string) ?? null,
    });
  }

  async handleLLMEnd(output: LLMResult, runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;

    const totalMs = Math.max(1, Date.now() - run.startedAt);
    const usage = output.llmOutput?.tokenUsage as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;

    try {
      await recordEvalRun({
        threadId: run.threadId || "dev-thread",
        userId: run.userId || "dev-user",
        agent: run.agent,
        templateId: run.templateId,
        variantId: run.variantId,
        parentMessageId: run.parentMessageId,
        inputTokens: usage?.promptTokens ?? null,
        outputTokens: usage?.completionTokens ?? null,
        totalMs,
        status: "success",
      });
      console.log(`[EvalCallbackHandler] Recorded LLM generation for ${run.agent} (${runId})`);
    } catch (err) {
      console.error("[EvalCallbackHandler] Error recording eval run:", err);
    }

    this.runs.delete(runId);
  }

  handleLLMError(error: Error, runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;

    const totalMs = Math.max(1, Date.now() - run.startedAt);

    recordEvalRun({
      threadId: run.threadId || "dev-thread",
      userId: run.userId || "dev-user",
      agent: run.agent,
      templateId: run.templateId,
      variantId: run.variantId,
      parentMessageId: run.parentMessageId,
      inputTokens: null,
      outputTokens: null,
      totalMs,
      status: "error",
      errorMessage: error.message,
    }).catch((err) => {
      console.error("[EvalCallbackHandler] Error recording failed LLM run:", err);
    });

    this.runs.delete(runId);
  }
}
