import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { listKbDocumentsGroupedByFolder } from "@/lib/kb/queries";

// ponytail: Settings → KB tab list. Per-user scoped at the query layer
// (listKbDocumentsGroupedByFolder filters by userId from withAuth).
// Returns folders + their docs in one round-trip — UI groups by folder
// name. No pagination yet (KB volume per user is O(tens of docs)).

export const GET = withAuth(async (_req, { user }) => {
  try {
    const groups = await listKbDocumentsGroupedByFolder(user.id);
    return NextResponse.json({
      groups: groups.map(({ folder, documents }) => ({
        folder: { id: folder.id, name: folder.name },
        documents: documents.map((d) => ({
          id: d.id,
          title: d.title,
          status: d.status,
          errorMessage: d.errorMessage,
          contentType: d.contentType,
          attachmentId: d.attachmentId,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        })),
      })),
    });
  } catch (err) {
    console.error("GET /api/kb/documents failed", err);
    return NextResponse.json({ code: "INTERNAL" }, { status: 500 });
  }
});
