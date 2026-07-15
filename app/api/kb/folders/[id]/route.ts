import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { deleteKbFolderForUser, findKbFolderById, listKbDocumentsByFolder } from "@/lib/kb/queries";

// ponytail: Settings → KB → folder delete. The DB has `folder_id ...
// ON DELETE RESTRICT` on kb_document, so Postgres refuses to drop a
// folder that still has docs. We surface that as 409 NON_EMPTY with
// a doc count, so the UI can render "delete its 3 docs first" instead
// of a generic FK-violation message.
export const DELETE = withAuth<{ id: string }>(async (_req, { user, params }) => {
  const folder = await findKbFolderById(user.id, params.id);
  if (!folder) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  const docs = await listKbDocumentsByFolder(user.id, folder.id);
  if (docs.length > 0) {
    return NextResponse.json({ code: "NON_EMPTY", docCount: docs.length }, { status: 409 });
  }
  const deleted = await deleteKbFolderForUser(user.id, folder.id);
  if (!deleted) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
});
