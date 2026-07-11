import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { computeCredits, recordLlmCall } from "./charge";
import { findProviderId, getModelRate } from "./build-model";
import { QuotaExceededError } from "./errors";

type RunMeta = {
  userId: string;
  agentName: string | undefined;
  modelName: string | undefined;
  baseUrl: string | null;
};

type LlmKwargsShape = {
  kwargs?: { configuration?: { baseURL?: string } };
};

/**
 * Read userId + agentName + modelName + baseURL from `handleLLMStart`'s
 * args. userId is set by the /api proxy onto RunnableConfig and
 * surfaced via metadata; agentName comes from LangChain's auto-injected
 * `langgraph_node`; modelName + baseURL come from the ChatModel
 * instance (ls_model_name is also in metadata; baseURL is only on the
 * instance — ChatOpenAI stores it under kwargs.configuration).
 *
 * Returns null when there's no userId (admin tooling, tests, anonymous
 * runs). Callers treat null as "skip recording".
 */
function resolveRunMeta(
  metadata: Record<string, unknown> | undefined,
  llm: unknown,
): RunMeta | null {
  const userId = typeof metadata?.userId === "string" ? metadata.userId : undefined;
  if (!userId) return null;

  const agentName = metadata?.langgraph_node as string | undefined;
  const modelName = metadata?.ls_model_name as string | undefined;
  const baseUrl = (llm as LlmKwargsShape | null)?.kwargs?.configuration?.baseURL ?? null;

  return { userId, agentName, modelName, baseUrl };
}

/**
 * Single source of truth for credit accounting inside the LangGraph graph.
 *
 * Lifecycle:
 *   handleLLMStart → resolveRunMeta → cache RunMeta in `runMeta` map keyed by runId
 *   handleLLMEnd   → look up RunMeta → findProviderId → recordLlmCall(status='success') → delete
 *   handleLLMError → look up RunMeta → findProviderId → recordLlmCall(status='error') → delete
 *
 * The map is necessary because `handleLLMEnd` / `handleLLMError` don't
 * reliably receive `metadata` or `llm` in real LangChain runtime — only
 * `handleLLMStart` does. Caching by runId is the only way to carry
 * userId + agentName + baseURL across the three hooks.
 *
 * Quota enforcement is NOT this handler's job — LangChain's CallbackManager
 * swallows throws from handleLLMStart, so a throw here would only fail the
 * bookkeeping step without interrupting the model call. Enforcement lives
 * in backend/model.ts's quota-aware wrapper, which throws BEFORE invoke/stream
 * runs and propagates the error to the graph node. This handler only records.
 *
 * Wired in via `compile({ callbacks: [creditTrackingHandler] })` —
 * the singleton is exported from `backend/callbacks.ts` and shared
 * across every compiled graph in the process.
 */
export class CreditTrackingHandler extends BaseCallbackHandler {
  name = "credit_tracking";

  private runMeta = new Map<string, RunMeta>();

  async handleLLMStart(
    llm: unknown,
    _prompts: string[],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _runName?: string,
  ): Promise<void> {
    const resolved = resolveRunMeta(metadata, llm);
    if (!resolved) return;

    this.runMeta.set(runId, resolved);
  }

  async handleLLMEnd(
    output: LLMResult,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _extraParams?: Record<string, unknown>,
  ): Promise<void> {
    const resolved = this.runMeta.get(runId);
    if (!resolved) return;
    this.runMeta.delete(runId);

    const usage = extractUsage(output);
    if (!usage) return;

    const providerId = await findProviderId({
      baseUrl: resolved.baseUrl,
      modelName: resolved.modelName,
    });
    if (!providerId || !resolved.modelName || !resolved.agentName) return;

    const rate = await getModelRate(providerId, resolved.modelName);
    const credits = computeCredits(usage, rate);

    await recordLlmCall({
      userId: resolved.userId,
      providerId,
      modelName: resolved.modelName,
      agentName: resolved.agentName,
      usage,
      status: "success",
      credits,
    });
  }

  async handleLLMError(
    err: Error,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _extraParams?: Record<string, unknown>,
  ): Promise<void> {
    const resolved = this.runMeta.get(runId);
    // Always clean up — even for QuotaExceededError we don't want the
    // entry to leak past this hook.
    this.runMeta.delete(runId);

    if (err instanceof QuotaExceededError) return; // no LLM call happened
    if (!resolved) return;

    const providerId = await findProviderId({
      baseUrl: resolved.baseUrl,
      modelName: resolved.modelName,
    });
    if (!providerId || !resolved.modelName || !resolved.agentName) return;

    await recordLlmCall({
      userId: resolved.userId,
      providerId,
      modelName: resolved.modelName,
      agentName: resolved.agentName,
      usage: { input: 0, output: 0 },
      status: "error",
      errorMessage: err.message,
      credits: 0,
    });
  }
}

/**
 * Token counts are reported differently by different providers / SDK
 * versions — pull from whichever field is populated. Returns null if
 * we genuinely can't find a count (caller skips recording).
 */
function extractUsage(output: LLMResult): { input: number; output: number } | null {
  // ponytail: union-narrowing the SDK types is brittle (LangChain has shifted
  // these shapes between minors). Cast to a loose record and probe field-by-field
  // — any provider we care about puts token counts under one of these names.
  const llmOutput = output.llmOutput as Record<string, unknown> | undefined;
  if (llmOutput) {
    const tokenUsage = llmOutput.tokenUsage ?? llmOutput.usage;
    if (tokenUsage && typeof tokenUsage === "object") {
      const t = tokenUsage as Record<string, unknown>;
      const input = Number(t.promptTokens ?? t.input_tokens ?? t.prompt_tokens ?? 0);
      const out = Number(t.completionTokens ?? t.output_tokens ?? t.completion_tokens ?? 0);
      if (input > 0 || out > 0) return { input, output: out };
    }
  }

  const first = output.generations?.[0]?.[0] as
    | { message?: { usage_metadata?: Record<string, unknown> } }
    | undefined;
  const meta = first?.message?.usage_metadata;
  if (meta) {
    const input = Number(meta.input_tokens ?? 0);
    const out = Number(meta.output_tokens ?? 0);
    if (input > 0 || out > 0) return { input, output: out };
  }

  return null;
}
