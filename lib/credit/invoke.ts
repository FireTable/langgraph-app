import { AIMessage } from "@langchain/core/messages";
import { QuotaExceededError } from "@/lib/credit/errors";

/**
 * Standard quota-exceeded assistant reply. Same shape the model would
 * produce, so the UI doesn't have to special-case it.
 *
 * Nodes catch `QuotaExceededError` from their `chatModel.invoke(...)`
 * (thrown by `CreditTrackingHandler.handleLLMStart` BEFORE the LLM
 * call goes out — LangChain propagates the callback throw as a
 * rejected promise) and return `{ messages: [reply] }` with this
 * message in place of a real AI reply.
 */
export function quotaExceededReply(err: QuotaExceededError): AIMessage {
  const minutes = Math.max(0, Math.round((err.resetAt.getTime() - Date.now()) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  const wait = hours > 0 ? `${hours}h ${remaining}m` : minutes > 0 ? `${minutes}m` : "soon";

  const text =
    `You've used today's free credits (${err.used.toFixed(1)}/${err.limit}). ` +
    `They reset in about ${wait}. Upgrade or come back later.`;

  return new AIMessage(text);
}
