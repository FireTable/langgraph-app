import { assignPromptVariant } from "@/lib/eval/queries";
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

const FALLBACK_PROMPTS: Record<string, string> = {
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

export async function getAgentPrompt(
  agentName: string,
  userId?: string,
): Promise<{ content: string; templateId: string; variantId: string }> {
  const fallbackText = FALLBACK_PROMPTS[agentName] ?? CHAT_AGENT_PROMPT;
  const fallback = {
    content: fallbackText,
    templateId: `fallback_${agentName}`,
    variantId: `fallback_${agentName}`,
  };

  if (!userId) return fallback;

  try {
    const assigned = await assignPromptVariant(userId, agentName);
    return assigned;
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[getAgentPrompt] Fallback to static prompt for ${agentName}:`, err);
    }
    return fallback;
  }
}
