import { NextResponse } from "next/server";
import { z } from "zod";

import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteKbFolderForUser,
  findKbChunksByFolderId,
  findKbFolderById,
  findKbFolderByName,
  listKbDocumentsByFolder,
  updateKbFolderNameForUser,
} from "@/lib/kb/queries";

// ponytail: Settings → KB → folder detail (combined graph). Returns the
// kb_folder row + chunks content of all documents in the folder.
export const GET = withAuth<{ id: string }>(async (_req, { user, params }) => {
  const folder = await findKbFolderById(user.id, params.id);
  if (!folder) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  const chunks = await findKbChunksByFolderId(user.id, folder.id);

  return NextResponse.json({
    folder: {
      id: folder.id,
      name: folder.name,
      createdAt: folder.createdAt.toISOString(),
    },
    chunks,
  });
});

// ponytail: Settings → KB → folder rename. Same UNIQUE(user_id, name)
// guard as POST /api/kb/folders — duplicate names surface as 409
// DUPLICATE, missing folder as 404. No body shape change; the
// `name` field is the only thing the UI edits.
const PatchBody = z.object({
  name: z.string().min(1).max(64).trim(),
});

export const PATCH = withAuth<{ id: string }>(async (req, { user, params }) => {
  const body = PatchBody.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ code: "INVALID_NAME" }, { status: 400 });
  }
  const { name } = body.data;

  const folder = await findKbFolderById(user.id, params.id);
  if (!folder) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  // Same name → no-op success.
  if (name === folder.name) {
    return NextResponse.json({ folder }, { status: 200 });
  }

  // ponytail: race-safe duplicate check. If another tab creates a
  // folder with the same name in between the SELECT and the UPDATE,
  // the UPDATE will fail with 23505 — catch + re-read + 409.
  const dup = await findKbFolderByName(user.id, name);
  if (dup && dup.id !== folder.id) {
    return NextResponse.json({ code: "DUPLICATE" }, { status: 409 });
  }

  try {
    const updated = await updateKbFolderNameForUser(user.id, folder.id, name);
    if (!updated) {
      return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ folder: updated }, { status: 200 });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ code: "DUPLICATE" }, { status: 409 });
    }
    console.error("PATCH /api/kb/folders/[id] failed", err);
    return NextResponse.json({ code: "INTERNAL" }, { status: 500 });
  }
});

// ponytail: Settings → KB → folder delete. The DB has `folder_id ...
// ON DELETE RESTRICT` on kb_document, so Postgres refuses to drop a
// folder that still has docs. We surface that as 409 NON_EMPTY with
// a doc count, so the UI can render "delete its 3 docs first" instead
// of a generic FK-violation message.
export const DELETE = withAuth<{ id: string }>(async (req, { user, params }) => {
  const folder = await findKbFolderById(user.id, params.id);
  if (!folder) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  const url = new URL(req.url);
  const deleteAll = url.searchParams.get("deleteAll") === "true";

  if (!deleteAll) {
    const docs = await listKbDocumentsByFolder(user.id, folder.id);
    if (docs.length > 0) {
      return NextResponse.json({ code: "NON_EMPTY", docCount: docs.length }, { status: 409 });
    }
  }

  const deleted = await deleteKbFolderForUser(user.id, folder.id, { deleteAllDocs: deleteAll });
  if (!deleted) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
});
