/**
 * Thrown by lib/credit/callback.ts inside handleLLMStart when the user's
 * rolling-window credit usage has reached role.creditLimit. LangChain
 * converts this into handleLLMError; the throwing node catches it and
 * writes a friendly assistant message to the thread instead of letting
 * the error bubble out of the graph.
 */
export class CreditExceededError extends Error {
  constructor(
    public readonly resetAt: Date,
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(`credit exceeded: ${used}/${limit}, resets at ${resetAt.toISOString()}`);
    this.name = "CreditExceededError";
  }
}