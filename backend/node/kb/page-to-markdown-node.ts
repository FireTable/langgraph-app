import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import PQueue from "p-queue";
import { z } from "zod";
import type { KbAgentStateShape, PageResult } from "@/backend/state";
import { getOcrModel } from "@/backend/model";
import { KB_OCR_PAGE_PROMPT } from "@/backend/prompt/system";
import { updateKbDocumentStatus } from "@/lib/kb/queries";
import { KB_OCR_CONCURRENCY } from "@/lib/constants";

export const ocrPageSchema = z.object({
  markdown: z
    .string()
    .describe(
      "Clean markdown extraction of this PDF page. " +
        "Preserve headings, lists, code blocks, tables, and inline formatting. " +
        "Return an empty string if the page is blank or contains only decorative images. " +
        "Output ONLY the markdown — no preamble, no commentary, no code fences.",
    ),
});

export async function pageToMarkdownNode(
  state: KbAgentStateShape,
): Promise<Partial<KbAgentStateShape>> {
  if (
    state.mode === "chunksOnly" ||
    state.mode === "retryFailed" ||
    state.mode === "retryFailedChunks"
  ) {
    return {
      pagesByDocId: state.pagesByDocId,
      processedFiles: state.processedFiles,
    };
  }

  const ocrModel = await getOcrModel();
  const system = new SystemMessage(KB_OCR_PAGE_PROMPT);
  const structured = ocrModel.withStructuredOutput(ocrPageSchema, {
    method: "jsonSchema",
    strict: true,
  });

  const queue = new PQueue({ concurrency: KB_OCR_CONCURRENCY });

  const updatedPagesByDocId: Record<string, PageResult[]> = { ...state.pagesByDocId };
  const updatedProcessed = state.processedFiles.map((p) => ({ ...p }));

  // ponytail: guard against files marked "new" that have no pages or empty pages
  for (const pf of state.processedFiles) {
    if (pf.pipelineStatus === "new" && pf.docId) {
      const pages = state.pagesByDocId[pf.docId];
      if (!pages || pages.length === 0) {
        const idx = updatedProcessed.findIndex((p) => p.docId === pf.docId);
        if (idx >= 0) {
          updatedProcessed[idx] = {
            ...updatedProcessed[idx],
            pipelineStatus: "failed",
            errorMessage: "Document has no pages to OCR",
          };
        }
        if (state.userId && pf.docId) {
          await updateKbDocumentStatus(state.userId, pf.docId, {
            status: "failed",
            errorMessage: "Document has no pages to OCR",
          }).catch(() => {});
        }
      }
    }
  }

  const newDocs = updatedProcessed.filter(
    (p) =>
      p.pipelineStatus === "new" && p.docId !== null && state.pagesByDocId[p.docId] !== undefined,
  );

  const results = await Promise.allSettled(
    newDocs.map((pf) =>
      queue.add(async () => {
        const pages = state.pagesByDocId[pf.docId!];
        const controller = new AbortController();
        let hasFailed = false;

        const ocrResults = await Promise.all(
          pages.map(async (p) => {
            if ((p.markdown ?? "").trim().length > 0 && !p.errorMessage) {
              return p;
            }

            if (hasFailed || controller.signal.aborted) {
              return {
                ...p,
                markdown: "",
                status: "failed" as const,
                errorMessage:
                  "Bypassed: OCR aborted due to another page failure in the same document",
              };
            }

            const contentParts: Array<{ type: string; [key: string]: unknown }> = [
              { type: "image_url", image_url: { url: p.imageUrl } },
            ];
            if (p.textBlocks && p.textBlocks.length > 0) {
              const lines = p.textBlocks.map(
                (b) =>
                  `  y=${b.bbox[1].toFixed(0)}-${b.bbox[3].toFixed(0)}  ${JSON.stringify(b.text.slice(0, 200))}`,
              );
              contentParts.push({
                type: "text",
                text: `Text Blocks (in source order, y = vertical position in PDF points):\n${lines.join("\n")}`,
              });
            }
            if (p.imageRefs && p.imageRefs.length > 0) {
              const lines = p.imageRefs.map(
                (img) =>
                  `  ${img.name}  bbox=[${img.bbox[0].toFixed(0)},${img.bbox[1].toFixed(0)},${img.bbox[2].toFixed(0)},${img.bbox[3].toFixed(0)}]  ${img.width}×${img.height}px  ${img.url}`,
              );
              contentParts.push({
                type: "text",
                text: `Image Inventory (use these exact URLs verbatim in inline image refs):\n${lines.join("\n")}`,
              });
            }
            if (p.referenceText?.trim()) {
              contentParts.push({
                type: "text",
                text: `Reference text extracted directly from the PDF (may contain layout noise — trust the image for structure):\n\n${p.referenceText}`,
              });
            }
            try {
              if (hasFailed || controller.signal.aborted) {
                return {
                  ...p,
                  markdown: "",
                  status: "failed" as const,
                  errorMessage:
                    "Bypassed: OCR aborted due to another page failure in the same document",
                };
              }
              const out = (await structured.invoke(
                [system, new HumanMessage({ content: contentParts })],
                { tags: ["nostream"], signal: controller.signal },
              )) as z.infer<typeof ocrPageSchema>;
              return {
                ...p,
                markdown: out.markdown.trim(),
                status: "success" as const,
                errorMessage: undefined,
              };
            } catch (err) {
              hasFailed = true;
              controller.abort();
              console.error(
                `kbAgent pageToMarkdownNode: OCR failed for doc ${pf.docId} page ${p.pageIndex}:`,
                err,
              );
              return {
                ...p,
                markdown: "",
                status: "failed" as const,
                errorMessage: (err as Error).message,
              };
            }
          }),
        );

        const docHasFailedPage = ocrResults.some((r) => r.status === "failed");
        const docHasEmptyMarkdown =
          !docHasFailedPage &&
          ocrResults.length > 0 &&
          ocrResults.every((r) => !r.markdown || r.markdown.trim() === "");
        const hasDocError = docHasFailedPage || docHasEmptyMarkdown;

        if (hasDocError) {
          const firstErr = docHasFailedPage
            ? (ocrResults.find((r) => r.errorMessage && !r.errorMessage.startsWith("Bypassed:"))
                ?.errorMessage ?? "OCR failed on one or more pages")
            : "empty markdown";

          const idx = updatedProcessed.findIndex((p) => p.docId === pf.docId);
          if (idx >= 0) {
            updatedProcessed[idx] = {
              ...updatedProcessed[idx],
              pipelineStatus: "failed",
              errorMessage: firstErr,
            };
          }

          if (state.userId && pf.docId) {
            try {
              await updateKbDocumentStatus(state.userId, pf.docId, {
                status: "failed",
                pages: ocrResults,
                errorMessage: firstErr,
              });
            } catch (statusErr) {
              console.error(
                `kbAgent pageToMarkdownNode: updateKbDocumentStatus failed for ${pf.docId}`,
                statusErr,
              );
            }
          }
          throw new Error(`OCR failed for document ${pf.docId}: ${firstErr}`);
        }

        updatedPagesByDocId[pf.docId!] = ocrResults;

        if (state.userId && pf.docId) {
          try {
            await updateKbDocumentStatus(state.userId, pf.docId, {
              status: "success",
              pages: ocrResults,
            });
          } catch (statusErr) {
            console.error(
              `kbAgent pageToMarkdownNode: updateKbDocumentStatus failed for ${pf.docId}`,
              statusErr,
            );
          }
        }

        return ocrResults;
      }),
    ),
  );

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason?.message ?? String(r.reason));
  if (errors.length > 0) {
    console.error(`kbAgent pageToMarkdownNode: ${errors.length} document(s) failed OCR:`, errors);
  }

  const allFailed =
    updatedProcessed.length > 0 && updatedProcessed.every((p) => p.pipelineStatus === "failed");

  return {
    pagesByDocId: updatedPagesByDocId,
    processedFiles: updatedProcessed,
    ...(allFailed ? { status: "failed", errorMessage: errors[0] ?? "OCR failed" } : {}),
  };
}
