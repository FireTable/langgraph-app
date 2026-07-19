import { tool, type StructuredTool } from "@langchain/core/tools";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { kbFolder } from "@/lib/kb/schema";
import { listKbDocumentsGroupedWithAttachment } from "@/lib/kb/queries";
import { extractUserId } from "@/backend/memory/recall";

import { thisUserId } from "./user-id";
import type {
  ListDocumentsArgs,
  ListDocumentsDoc,
  ListDocumentsFolder,
  ListDocumentsResult,
} from "./types";

// ponytail: the four statuses are mirrored in the DB column enum + the
// API mention endpoint. Single source of truth here.
export const LIST_DOCUMENTS_STATUSES = ["success", "failed", "parsing", "pending"] as const;

const listDocumentsSchema = z.object({
  folderId: z.string().optional().describe("Restrict to a specific folder. Omit for all folders."),
  status: z
    .enum(["success", "failed", "parsing", "pending"])
    .optional()
    .describe("Filter by ingest status. Defaults to 'success' — only fully-ingested docs."),
  titleQuery: z.string().optional().describe("Case-insensitive substring match on document title."),
  page: z.number().int().min(1).optional().describe("1-indexed page number. Default 1."),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Per-folder cap on documents returned. Default 20, max 100."),
}) satisfies z.ZodType<ListDocumentsArgs>;

// ponytail: chat-tool view of a KB document. Strip the heavy fields
// (attachment URL, raw pages array, folderId) the LLM / chat card
// doesn't need — just the badge fields + a stable identifier.
function toListDoc(row: {
  id: string;
  title: string;
  status: "success" | "failed" | "parsing" | "pending";
  errorMessage: string | null;
  createdAt: Date;
  totalPages?: number;
  failedPages?: number;
  parsingPages?: number;
  pendingPages?: number;
  totalChunks?: number;
  successChunks?: number;
  failedChunks?: number;
  pendingChunks?: number;
  parsingChunks?: number;
}): ListDocumentsDoc {
  const totalPages = row.totalPages ?? 0;
  const pending = row.pendingPages ?? 0;
  const parsing = row.parsingPages ?? 0;
  const failed = row.failedPages ?? 0;
  const success = Math.max(totalPages - pending - parsing - failed, 0);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    totalPages,
    successPages: success,
    failedPages: failed,
    parsingPages: parsing,
    pendingPages: pending,
    totalChunks: row.totalChunks ?? 0,
    successChunks: row.successChunks ?? 0,
    failedChunks: row.failedChunks ?? 0,
    pendingChunks: row.pendingChunks ?? 0,
    parsingChunks: row.parsingChunks ?? 0,
  };
}

// ponytail: Title Case the folder name for the LLM-facing content
// so the model doesn't have to deal with all-caps user-typed names
// like "ARCBLOCK". The chat card displays the original name as-is
// — only the LLM string is normalised.
function titleCase(s: string): string {
  return s
    .split(/(\s+|-|_)/)
    .map((part) =>
      part.match(/\s+|-|_/) ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("");
}

export async function listKbDocumentsForUser(
  args: ListDocumentsArgs & { userId: string },
): Promise<ListDocumentsResult> {
  const page = args.page ?? 1;
  const pageSize = Math.min(args.pageSize ?? 20, 100);
  const status = args.status ?? "success";
  const titleQuery = args.titleQuery?.trim();

  const groups = await listKbDocumentsGroupedWithAttachment(args.userId, args.folderId ?? null);

  const folders: ListDocumentsFolder[] = [];
  let total = 0;
  for (const g of groups) {
    let docs = g.documents;
    if (status) docs = docs.filter((d) => d.status === status);
    if (titleQuery) {
      const q = titleQuery.toLowerCase();
      docs = docs.filter((d) => d.title.toLowerCase().includes(q));
    }
    docs = docs.slice(0, pageSize);
    folders.push({ id: g.folder.id, name: g.folder.name, documents: docs.map(toListDoc) });
    total += docs.length;
  }

  return { folders, total, page, pageSize };
}

// ponytail: LLM-facing summary string. Kept terse — folder names + doc
// titles + status + a short error tail. The structured `folders`
// field carries the badge data for the chat card; the LLM doesn't
// need chunk/page counts to decide what to do next.
function buildListContent(folders: ListDocumentsFolder[]): string {
  const parts: string[] = [];
  for (const f of folders) {
    if (f.documents.length === 0) continue;
    parts.push(
      `[Folder "${titleCase(f.name)}" (${f.documents.length} ${f.documents.length === 1 ? "document" : "documents"})]`,
    );
    for (const d of f.documents) {
      const err = d.status === "failed" && d.errorMessage ? ` — ${d.errorMessage}` : "";
      parts.push(`  - ${d.title} (id=${d.id}, status=${d.status}${err})`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "No documents matched.";
}

export const listDocumentsTool: StructuredTool = tool(
  async (args, config) => {
    const userId = extractUserId(config) ?? thisUserId();
    const result = await listKbDocumentsForUser({ ...args, userId });
    return JSON.stringify({
      ...result,
      content: buildListContent(result.folders),
      empty: result.folders.every((f) => f.documents.length === 0),
    });
  },
  {
    name: "list_documents",
    description:
      "List the user's knowledge-base documents grouped by folder. Supports filtering " +
      "by folder, ingest status, and title substring. Returns each document's id, " +
      "title, status, and per-doc page/chunk progress counts. Use when the user " +
      "asks what's in their KB or wants to navigate to a specific doc.",
    schema: listDocumentsSchema,
  },
);

// ponytail: re-exported so the @mention composer API route can pull the
// user's folder list without going through queries.ts. Not a tool.
export async function listKbFoldersForUser(
  userId: string,
): Promise<Array<typeof kbFolder.$inferSelect>> {
  return db.select().from(kbFolder).where(eq(kbFolder.userId, userId)).orderBy(asc(kbFolder.name));
}
