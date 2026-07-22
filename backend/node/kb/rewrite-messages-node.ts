import type { BaseMessage } from "@langchain/core/messages";
import type { KbAgentStateShape } from "@/backend/state";
import { stampKbRefOnFilename } from "@/lib/kb/extract";

export async function rewriteMessagesNode(
  state: KbAgentStateShape,
): Promise<Partial<KbAgentStateShape>> {
  if (
    state.mode === "chunksOnly" ||
    state.mode === "retryFailed" ||
    state.mode === "retryFailedChunks"
  ) {
    return { messages: state.messages };
  }

  const byMsgIdx = new Map<number, typeof state.processedFiles>();
  for (const pf of state.processedFiles) {
    const list = byMsgIdx.get(pf.messageIndex) ?? [];
    list.push(pf);
    byMsgIdx.set(pf.messageIndex, list);
  }

  const updatedMessages: BaseMessage[] = state.messages.map((msg, msgIdx) => {
    const filesForMsg = byMsgIdx.get(msgIdx);
    if (!filesForMsg || filesForMsg.length === 0) return msg;

    const fileMap = new Map(filesForMsg.map((pf) => [pf.filePart, pf]));

    const contentParts = (msg as { content: unknown }).content;
    if (!Array.isArray(contentParts)) return msg;

    const newContentParts: Array<unknown> = [];
    for (const part of contentParts) {
      const match = fileMap.get(part as never);
      if (match) {
        if (match.pipelineStatus === "unknown") {
          continue;
        }
        if (match.docId) {
          const filePart = part as Record<string, unknown>;

          const fileName =
            filePart.filename ??
            (filePart as { metadata: { filename: string } })?.metadata?.filename;

          const newFileName = stampKbRefOnFilename(fileName as string, match.docId);

          const stampedPart = {
            ...filePart,
            filename: newFileName,
            kb_ref: { docId: match.docId, attachmentId: match.attachmentId ?? undefined },
            metadata: {
              ...(filePart.metadata as Record<string, unknown>),
              filename: newFileName,
            },
          };
          newContentParts.push(stampedPart);
        } else {
          newContentParts.push(part);
        }
      } else if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: string }).type === "file"
      ) {
        // Strip non-ingestible file parts (audio, unhandled binaries)
        continue;
      } else {
        newContentParts.push(part);
      }
    }

    const cloned = Object.assign(Object.create(Object.getPrototypeOf(msg)), msg);
    cloned.content = newContentParts;
    return cloned;
  });

  return { messages: updatedMessages };
}
