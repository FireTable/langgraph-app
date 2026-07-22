import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { KbAgentStateShape } from "@/backend/state";
import { getExtractModel } from "@/backend/model";
import { KB_ENTITY_ALIGNMENT_SYSTEM_PROMPT } from "@/backend/prompt/system";
import {
  findKbDocumentById,
  findCanonicalEntitiesByDocId,
  findCanonicalRelationshipsByDocId,
  updateKbDocumentStatus,
} from "@/lib/kb/queries";

const alignmentSchema = z.object({
  entityAliases: z.array(
    z.object({
      canonicalName: z.string(),
      aliases: z.array(z.string()),
    }),
  ),
});

export async function resolveEntityAliasesForDoc(args: {
  userId: string;
  documentId?: string;
  docId?: string;
  documentTitle?: string;
  docTitle?: string;
  config?: RunnableConfig;
}): Promise<void> {
  const userId = args.userId;
  const documentId = args.documentId ?? args.docId ?? "";
  const titleInput = args.documentTitle ?? args.docTitle;
  const documentTitle =
    titleInput && titleInput.trim().length > 0 ? titleInput : "Unknown Document";
  const config = args.config;

  const rawEntities = await findCanonicalEntitiesByDocId(userId, documentId);
  const rawRelationships = await findCanonicalRelationshipsByDocId(userId, documentId);

  if (rawEntities.length <= 1) {
    return;
  }

  const systemMessage = new SystemMessage(KB_ENTITY_ALIGNMENT_SYSTEM_PROMPT);

  const entityLines = rawEntities.map(
    (e) => `- ${e.name} (${e.type}): ${e.description ?? "no description"}`,
  );
  const relLines = rawRelationships.map(
    (r) => `- ${r.source} -> ${r.relation} -> ${r.target}: ${r.description ?? "no description"}`,
  );

  const humanMessage = new HumanMessage(
    `Document Title: [${documentTitle}]\n\n` +
      `Extracted Entities (${rawEntities.length}):\n${entityLines.join("\n")}\n\n` +
      `Extracted Relationships (${rawRelationships.length}):\n${relLines.join("\n")}`,
  );

  try {
    const extractModel = await getExtractModel();
    const alignmentOut = (await extractModel
      .withStructuredOutput(alignmentSchema, { method: "jsonSchema", strict: true })
      .invoke([systemMessage, humanMessage], {
        ...config,
        tags: ["nostream"],
      })) as z.infer<typeof alignmentSchema>;

    const rawAliases = alignmentOut?.entityAliases ?? (alignmentOut as any)?.mappings ?? [];
    const aliases = rawAliases.filter((m: any) => {
      if (m.original && m.canonical) return m.original !== m.canonical;
      if (m.canonicalName && Array.isArray(m.aliases)) {
        return m.aliases.some((a: string) => a !== m.canonicalName);
      }
      return false;
    });
    console.log(
      `[resolveEntityAliasesForDoc] docId=${documentId}: resolved ${aliases.length} canonical alias mapping(s)`,
    );

    await updateKbDocumentStatus(userId, documentId, { status: "success" });
  } catch (err) {
    console.error(
      `[resolveEntityAliasesForDoc] alignment LLM pass failed for docId=${documentId}, marking success with raw extracted graph:`,
      err,
    );
    await updateKbDocumentStatus(userId, documentId, { status: "success" });
  }
}

export async function entityAlignmentNode(
  state: KbAgentStateShape,
  config?: RunnableConfig,
): Promise<Partial<KbAgentStateShape>> {
  console.log(
    `[kbAgent] Entering entityAlignmentNode, files=`,
    state.processedFiles.map((p) => ({ docId: p.docId, status: p.pipelineStatus })),
  );

  const isRetryFailedChunks = state.mode === "retryFailedChunks";
  const alignedDocs: string[] = [];

  if (state.userId && !isRetryFailedChunks) {
    for (const pf of state.processedFiles) {
      if (pf.docId && pf.pipelineStatus !== "failed" && pf.pipelineStatus !== "unknown") {
        const docId = pf.docId;
        const userId = state.userId;
        const doc = await findKbDocumentById(userId, docId);
        const docTitle = doc?.title ?? "Unknown Document";

        await resolveEntityAliasesForDoc({
          userId,
          documentId: docId,
          documentTitle: docTitle,
          config,
        });

        alignedDocs.push(docId);
      }
    }
  }

  return { alignedEntities: alignedDocs };
}
