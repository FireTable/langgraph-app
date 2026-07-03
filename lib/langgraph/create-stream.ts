// ponytail: own thin implementation of the upstream
// `unstable_createLangGraphStream` from `@assistant-ui/react-langgraph`.
// We were going to thread `parentMessageId` via `config.configurable`
// here, but the backend derives the same id from `inputs.messages`
// directly (lastHumanMessageId in callback-collector.ts), and the
// configurable path is missed on interrupt resume (useSendCommand
// bypasses stream). Dropping the thread-through — single source of
// truth stays in the backend.
import type { Client, StreamMode } from "@langchain/langgraph-sdk";
import type { LangChainMessage, LangGraphStreamCallback } from "@assistant-ui/react-langgraph";

export type LangGraphStreamClient = {
  runs: Pick<Client["runs"], "stream">;
};

type StreamPayload = NonNullable<Parameters<LangGraphStreamClient["runs"]["stream"]>[2]>;

export type CreateLangGraphStreamOptions = {
  client: LangGraphStreamClient;
  assistantId: string;
  streamMode?: StreamMode | StreamMode[];
  onDisconnect?: StreamPayload["onDisconnect"];
};

export function createLangGraphStream({
  client,
  assistantId,
  streamMode = ["messages", "updates", "custom"],
  onDisconnect = "cancel",
}: CreateLangGraphStreamOptions): LangGraphStreamCallback<LangChainMessage> {
  return async (messages, config) => {
    const { externalId } = await config.initialize();
    if (!externalId) throw new Error("Thread has not been initialized.");

    const payload = {
      input: messages.length ? { messages } : null,
      streamMode,
      signal: config.abortSignal,
      onDisconnect,
      multitaskStrategy: "interrupt",
      ...(config.command != null && { command: config.command }),
      ...(config.checkpointId != null && {
        checkpoint: { checkpoint_id: config.checkpointId },
      }),
      ...(config.runConfig !== undefined && { config: config.runConfig }),
    } as StreamPayload;

    return client.runs.stream(externalId, assistantId, payload);
  };
}
