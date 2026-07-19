import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { listKbDocumentsByFolder, listKbDocumentsGroupedWithAttachment } from "@/lib/kb/queries";

// ponytail: Settings → KB tab list. Per-user scoped at the query layer
// (the helper filters by userId from withAuth). Returns folders + their
// docs in one round-trip, with attachmentUrl joined in for the "View
// source" link. No pagination yet (KB volume per user is O(tens of docs)).
//
// v3: also serves the @-mention composer. When `?mention=1` is set,
// returns a flat list of `status='success'` docs (the popover shows
// only ingest-ready docs). The flat mode skips the folder grouping and
// limits each doc to the fields the popover needs.

type GroupedDoc = {
  id: string;
  title: string;
  status: string;
  errorMessage: string | null;
  contentType: string;
  attachmentId: string | null;
  attachmentUrl: string | null;
  createdAt: string;
  updatedAt: string;
  totalChunks?: number;
  successChunks?: number;
  failedChunks?: number;
  totalPages?: number;
  failedPages?: number;
};

export const GET = withAuth(async (req: Request, { user }) => {
  const { searchParams } = new URL(req.url);
  const mentionMode = searchParams.get("mention") === "1";

  try {
    if (mentionMode) {
      // ponytail: composer popover surface. Now grouped by folder so the
      // popover can drill into folders as categories. Empty folders are
      // dropped (a folder with zero ingest-ready docs has nothing to
      // offer the user). Folders with zero docs at all are also dropped
      // — keeps the popover focused on actionable choices.
      const groups = await listKbDocumentsGroupedWithAttachment(user.id);
      const folders = groups
        .map(({ folder, documents }) => {
          const successDocs = documents
            .filter((d) => d.status === "success")
            .map((d) => ({
              id: d.id,
              title: d.title,
              status: d.status,
            }));
          if (successDocs.length === 0) return null;
          return {
            id: folder.id,
            name: folder.name,
            docCount: successDocs.length,
            docs: successDocs,
          };
        })
        .filter((g): g is NonNullable<typeof g> => g !== null);
      return NextResponse.json({ folders });
    }

    const groups = await listKbDocumentsGroupedWithAttachment(user.id);
    return NextResponse.json({
      groups: groups.map(({ folder, documents }) => ({
        folder: { id: folder.id, name: folder.name },
        documents: documents.map(
          (d): GroupedDoc => ({
            id: d.id,
            title: d.title,
            status: d.status,
            errorMessage: d.errorMessage,
            contentType: d.contentType,
            attachmentId: d.attachmentId,
            attachmentUrl: d.attachmentUrl,
            createdAt: d.createdAt.toISOString(),
            updatedAt: d.updatedAt.toISOString(),
            totalChunks: d.totalChunks,
            successChunks: d.successChunks,
            failedChunks: d.failedChunks,
            totalPages: d.totalPages,
            failedPages: d.failedPages,
          }),
        ),
      })),
    });
  } catch (err) {
    console.error("GET /api/kb/documents failed", err);
    return NextResponse.json({ code: "INTERNAL" }, { status: 500 });
  }
});

// keep unused-import referenced for tree-shake tests
void listKbDocumentsByFolder;
