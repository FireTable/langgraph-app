import type { RunnableConfig } from "@langchain/core/runnables";
import { randomUUID } from "node:crypto";
import type { KbAgentStateShape, PageResult, ProcessedFile } from "@/backend/state";
import {
  ensureDefaultKbFolder,
  findKbDocumentByAttachmentId,
  findKbDocumentByContentHash,
  findKbDocumentById,
  insertKbDocument,
  insertKbObservability,
  updateKbDocumentStatus,
} from "@/lib/kb/queries";
import { findAttachmentByR2Key } from "@/lib/attachments/queries";
import { extractAllPdfParts } from "@/lib/kb/extract";
import { r2KeyFromPublicUrl, getR2PublicBaseUrl } from "@/lib/r2/client";
import { lastHumanMessageId } from "@/lib/langgraph/last-human-message-id";

function makeError(reason: string): Partial<KbAgentStateShape> {
  return {
    status: "failed",
    errorMessage: reason,
    processedFiles: [],
  };
}

export async function prepareKBDataNode(
  state: KbAgentStateShape,
  config?: RunnableConfig & {
    configurable?: {
      mode?: "full" | "chunksOnly" | "retryFailed" | "retryFailedChunks";
      docId?: string;
      forceRerun?: boolean;
      userId?: string;
      source?: "chat" | "kb-upload" | "kb-reprocess";
      thread_id?: string;
      parent_message_id?: string;
      run_id?: string;
    };
  },
): Promise<Partial<KbAgentStateShape>> {
  const mode = config?.configurable?.mode ?? state.mode ?? "full";
  const userId = config?.configurable?.userId ?? state.userId;

  if (!userId) return makeError("user not provided");

  const source = config?.configurable?.source ?? "chat";
  const parentMessageId = lastHumanMessageId(state.messages);
  if (!parentMessageId) {
    return makeError("kbAgent prepareKBDataNode: no HumanMessage to anchor parent_message_id on");
  }

  const runId = config?.configurable?.run_id ?? null;
  const threadId = config?.configurable?.thread_id ?? null;

  if (mode === "chunksOnly" || mode === "retryFailed" || mode === "retryFailedChunks") {
    const targetDocId = config?.configurable?.docId ?? state.docId;
    if (!targetDocId) {
      return makeError(`${mode} requires docId`);
    }
    const doc = await findKbDocumentById(userId, targetDocId);
    if (!doc) return makeError(`doc ${targetDocId} not found`);
    if (threadId) {
      await insertKbObservability({
        docId: doc.id,
        threadId,
        parentMessageId,
        runId,
        source,
        mode,
      });
    }
    if (doc.status !== "success" && doc.status !== "failed" && doc.status !== "parsing") {
      return makeError(
        `${mode} requires settled doc or parsing doc, got status='${doc.status}'. Run full reprocess first.`,
      );
    }
    const pages = (doc.pages ?? []) as PageResult[];
    const stubFilePart = { type: "file" as const, url: "", data: "", metadata: {} as never };
    return {
      userId,
      mode,
      docId: doc.id,
      pagesByDocId: { [doc.id]: pages },
      processedFiles: [
        {
          messageIndex: -1,
          filePart: stubFilePart as never,
          docId: doc.id,
          attachmentId: doc.attachmentId,
          r2Key: null,
          title: doc.title,
          contentHash: doc.contentHash,
          contentType: doc.contentType,
          pipelineStatus: "new",
          errorMessage: null,
          existingStatus: doc.status,
        },
      ],
      status: mode === "retryFailed" ? "parsing" : doc.status,
      errorMessage: null,
    };
  }

  const pdfs = extractAllPdfParts(state.messages);
  if (pdfs.length === 0) return makeError("no PDF file parts found");

  const base = getR2PublicBaseUrl();

  const processed = await Promise.all(
    pdfs.map(async ({ messageIndex, filePart }): Promise<ProcessedFile> => {
      const url = filePart.url || filePart.data;
      const r2Key = r2KeyFromPublicUrl(url, base);
      try {
        const attachment = await findAttachmentByR2Key(userId, r2Key);
        if (!attachment) {
          return {
            messageIndex,
            filePart,
            docId: null,
            attachmentId: null,
            r2Key,
            title: null,
            contentHash: null,
            contentType: null,
            pipelineStatus: "unknown",
            errorMessage: "attachment not found",
          };
        }
        const contentHash = attachment.sha256 ?? `r2key:${attachment.r2Key}`;

        let existing = await findKbDocumentByContentHash(userId, contentHash);
        if (!existing) existing = await findKbDocumentByAttachmentId(userId, attachment.id);
        if (existing) {
          const forceRerun = config?.configurable?.forceRerun ?? false;
          if (!forceRerun && (existing.status === "success" || existing.status === "failed")) {
            return {
              messageIndex,
              filePart,
              docId: existing.id,
              attachmentId: attachment.id,
              r2Key: attachment.r2Key,
              title: attachment.name,
              contentHash,
              contentType: attachment.contentType,
              pipelineStatus: "dedup",
              errorMessage: existing.errorMessage,
              existingStatus: existing.status,
            };
          }
          return {
            messageIndex,
            filePart,
            docId: existing.id,
            attachmentId: attachment.id,
            r2Key: attachment.r2Key,
            title: attachment.name,
            contentHash,
            contentType: attachment.contentType,
            pipelineStatus: "new",
            errorMessage: null,
            existingStatus: existing.status,
          };
        }

        const docId = `d-${randomUUID()}`;
        return {
          messageIndex,
          filePart,
          docId,
          attachmentId: attachment.id,
          r2Key: attachment.r2Key,
          title: attachment.name,
          contentHash,
          contentType: attachment.contentType,
          pipelineStatus: "new",
          errorMessage: null,
        };
      } catch (err) {
        return {
          messageIndex,
          filePart,
          docId: null,
          attachmentId: null,
          r2Key,
          title: null,
          contentHash: null,
          contentType: null,
          pipelineStatus: "failed",
          errorMessage: (err as Error).message,
        };
      }
    }),
  );

  const folder = await ensureDefaultKbFolder(userId, "Attachments");
  const newDocs = processed.filter(
    (p) => p.pipelineStatus === "new" && p.docId !== null && p.attachmentId !== null,
  );

  await Promise.allSettled(
    newDocs.map(async (pf) => {
      try {
        await insertKbDocument({
          id: pf.docId!,
          userId,
          folderId: folder.id,
          attachmentId: pf.attachmentId!,
          title: pf.title ?? "untitled",
          contentType: pf.contentType ?? "application/pdf",
          contentHash: pf.contentHash!,
          status: "parsing",
          errorMessage: null,
        });
      } catch (err) {
        const code =
          (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (code === "23505") {
          try {
            await updateKbDocumentStatus(userId, pf.docId!, {
              status: "parsing",
              errorMessage: null,
            });
          } catch (statusErr) {
            console.error(
              `kbAgent prepareKBDataNode: recovery UPDATE failed for ${pf.docId}`,
              statusErr,
            );
          }
          return;
        }
        console.error(`kbAgent prepareKBDataNode: insertKbDocument failed for ${pf.docId}`, err);
      } finally {
        if (threadId) {
          await insertKbObservability({
            docId: pf.docId!,
            threadId,
            parentMessageId,
            runId,
            source,
            mode,
          });
        }
      }
    }),
  );

  const hasValid = processed.some(
    (p) => p.pipelineStatus === "new" || p.pipelineStatus === "dedup",
  );
  if (!hasValid) {
    return {
      userId,
      mode,
      processedFiles: processed,
      status: "failed",
      errorMessage: "no PDF could be processed",
    };
  }

  return {
    userId,
    mode,
    processedFiles: processed,
    status: "parsing",
  };
}
