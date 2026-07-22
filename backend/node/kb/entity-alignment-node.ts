import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { KbAgentStateShape } from "@/backend/state";
import { getExtractModel } from "@/backend/model";
import { KB_ENTITY_ALIGNMENT_SYSTEM_PROMPT } from "@/backend/prompt/system";
import {
  applyThemeAlignment,
  findCanonicalEntitiesByDocId,
  findCanonicalRelationshipsByDocId,
  findKbDocumentById,
  updateKbDocumentStatus,
} from "@/lib/kb/queries";

const alignmentSchema = z.object({
  entityAliases: z.array(
    z.object({
      canonicalName: z.string(),
      aliases: z.array(z.string()),
    }),
  ),
  // ponytail: themes ride along the same LLM pass for free (we
  // already pay the LLM cost per doc). Each group folds surface-form
  // variants of the same macro topic ("AI 应用" + "AI App" + "应用
  // AI") into one canonical name. applyThemeAlignment in queries.ts
  // UPDATEs kb_theme rows in-place and dedupes per-(chunk_id, name).
  // Required (not .optional()) — see CLAUDE.md rule on
  // withStructuredOutput schemas; OpenAI strict mode rejects
  // optional / defaultless arrays.
  themeAliases: z.array(
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

    // ponytail: legacy callers used a different shape (`{original,
    // canonical}` per row). We accept either format for entityAliases
    // and normalise to `{canonicalName, aliases}` here.
    const rawAliases = alignmentOut?.entityAliases ?? (alignmentOut as any)?.mappings ?? [];
    const aliases = rawAliases
      .map((m: any) => {
        if (m.canonicalName && Array.isArray(m.aliases)) {
          return { canonicalName: m.canonicalName, aliases: m.aliases as string[] };
        }
        if (m.original && m.canonical) {
          return { canonicalName: m.canonical, aliases: [m.original] };
        }
        return null;
      })
      .filter((m: { canonicalName: string; aliases: string[] } | null) => {
        if (!m) return false;
        return m.aliases.some((a) => a !== m.canonicalName);
      });
    console.log(
      `[resolveEntityAliasesForDoc] docId=${documentId}: resolved ${aliases.length} canonical alias mapping(s) for entities`,
    );

    // ponytail: theme alignment runs alongside entity alignment —
    // same LLM pass, no extra call. We UPDATE kb_theme.name in place
    // (no canonical column; variant loss is fine for LLM-generated
    // theme tokens). Original-variant noise and concept-level dupes
    // ("AI 应用" vs "AI 应用开发") are then deduped to a single row
    // per (chunk_id, name) inside applyThemeAlignment.
    const themeAliases = (alignmentOut.themeAliases ?? []).filter(
      (m) => Array.isArray(m.aliases) && m.aliases.some((a) => a !== m.canonicalName),
    );
    if (themeAliases.length > 0) {
      const result = await applyThemeAlignment({
        userId,
        documentId,
        mappings: themeAliases.map((m) => ({
          canonical: m.canonicalName,
          aliases: m.aliases,
        })),
      });
      console.log(
        `[resolveEntityAliasesForDoc] docId=${documentId}: theme alignment renamed ${result.updated} row(s), deduped ${result.deduped} collision(s)`,
      );
    }

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
