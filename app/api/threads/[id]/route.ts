import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getThreadForUser,
  renameThread,
  archiveThread,
  unarchiveThread,
  updateCustom,
  deleteThread,
} from "@/lib/threads/queries";
import { RenameThreadBody, UpdateStatusBody, UpdateCustomBody } from "@/lib/threads/validators";
import { withAuth } from "@/lib/auth/with-auth";
import type { Thread } from "@/lib/threads/schema";

type IdParams = { id: string };

const PatchBody = z.union([RenameThreadBody, UpdateStatusBody, UpdateCustomBody]);

export const GET = withAuth<IdParams>(async (_req, { userId, params }) => {
  const row = await getThreadForUser(params.id, userId);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(toThreadMetadata(row));
});

export const PATCH = withAuth<IdParams>(async (req, { userId, params }) => {
  const json = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const existing = await getThreadForUser(params.id, userId);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  if ("title" in body) {
    await renameThread(params.id, body.title);
  } else if ("status" in body) {
    if (body.status === "archived") await archiveThread(params.id, userId);
    else await unarchiveThread(params.id, userId);
  } else if ("custom" in body) {
    await updateCustom(params.id, userId, body.custom);
  }
  const row = await getThreadForUser(params.id, userId);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(toThreadMetadata(row));
});

export const DELETE = withAuth<IdParams>(async (_req, { userId, params }) => {
  const existing = await getThreadForUser(params.id, userId);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  await deleteThread(params.id, userId);
  return new NextResponse(null, { status: 204 });
});

function toThreadMetadata(row: Thread) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    lastMessageAt: row.lastMessageAt,
  };
}
