import type { KbAgentStateShape, PageResult } from "@/backend/state";
import { getIngestHandler } from "@/lib/kb/ingest-handlers";
import { updateKbDocumentStatus } from "@/lib/kb/queries";

export async function splitFileToPageNode(
  state: KbAgentStateShape,
): Promise<Partial<KbAgentStateShape>> {
  const newDocs = state.processedFiles.filter(
    (p) => p.pipelineStatus === "new" && p.docId !== null && p.r2Key !== null,
  );

  const pagesByDocId: Record<string, PageResult[]> = {};
  const updatedProcessed = state.processedFiles.map((p) => ({ ...p }));

  for (const pf of newDocs) {
    const handler = pf.contentType ? getIngestHandler(pf.contentType) : null;
    if (!handler) {
      throw new Error(`kbAgent splitFileToPageNode: no handler for mime ${pf.contentType}`);
    }
    try {
      const pages = await handler.buildPages({
        r2Key: pf.r2Key!,
        userId: state.userId!,
        docId: pf.docId!,
        name: pf.title ?? "untitled",
        contentType: pf.contentType!,
      });
      pagesByDocId[pf.docId!] = pages;
      if (state.userId && pf.docId) {
        await updateKbDocumentStatus(state.userId, pf.docId, {
          status: "parsing",
          pages,
        });
      }
    } catch (err) {
      const idx = state.processedFiles.indexOf(pf);
      if (idx >= 0) {
        updatedProcessed[idx] = {
          ...updatedProcessed[idx],
          pipelineStatus: "failed",
          errorMessage: (err as Error).message,
        };
      }

      console.error("kbAgent splitFileToPageNode", err);

      if (state.userId && pf.docId) {
        try {
          await updateKbDocumentStatus(state.userId, pf.docId, {
            status: "failed",
            errorMessage: (err as Error).message,
          });
        } catch (statusErr) {
          console.error(
            `kbAgent splitFileToPageNode: updateKbDocumentStatus failed for ${pf.docId}`,
            statusErr,
          );
        }
      }
    }
  }

  return { pagesByDocId, processedFiles: updatedProcessed };
}
