import { tool, type StructuredTool } from "@langchain/core/tools";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { kbDocument, kbFolder } from "@/lib/kb/schema";
import { extractUserId } from "@/backend/memory/recall";

import { thisUserId } from "./user-id";
import type { ListDocumentsArgs, ListDocumentsResult } from "./types";

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
  pageSize: z.number().int().min(1).max(100).optional().describe("Page size. Default 20, max 100."),
}) satisfies z.ZodType<ListDocumentsArgs>;

export async function listKbDocumentsForUser(
  args: ListDocumentsArgs & { userId: string },
): Promise<ListDocumentsResult> {
  const page = args.page ?? 1;
  const pageSize = Math.min(args.pageSize ?? 20, 100);
  const status = args.status ?? "success";

  const where = [
    eq(kbDocument.userId, args.userId),
    eq(kbDocument.status, status),
    args.folderId ? eq(kbDocument.folderId, args.folderId) : undefined,
    args.titleQuery ? ilike(kbDocument.title, `%${args.titleQuery}%`) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];

  // ponytail: total count + page rows in parallel — the count is
  // O(few-ms) on the same WHERE so it's worth running alongside.
  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(kbDocument)
      .where(and(...where))
      .orderBy(desc(kbDocument.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbDocument)
      .where(and(...where)),
  ]);

  return {
    documents: rows,
    total: Number(totalRows[0]?.count ?? 0),
    page,
    pageSize,
  };
}

export const listDocumentsTool: StructuredTool = tool(
  async (args, config) => {
    const userId = extractUserId(config) ?? thisUserId();
    const result = await listKbDocumentsForUser({ ...args, userId });
    return JSON.stringify({ ...result, empty: result.documents.length === 0 });
  },
  {
    name: "list_documents",
    description:
      "List the user's knowledge-base documents. Supports filtering by folder, " +
      "ingest status, and title substring. Returns a paginated list with the " +
      "document id, title, status, folder, and creation time. Use when the " +
      "user asks what's in their KB or wants to navigate to a specific doc.",
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
