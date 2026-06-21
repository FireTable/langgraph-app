import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getThread,
  renameThread,
  archiveThread,
  unarchiveThread,
  updateCustom,
  deleteThread,
} from "@/lib/threads/queries";
import { RenameThreadBody, UpdateStatusBody, UpdateCustomBody } from "@/lib/threads/validators";
import type { Thread } from "@/lib/threads/schema";

type RouteContext = { params: Promise<{ id: string }> };

// PATCH body is a discriminated union of { title }, { status }, { custom }.
// We accept any one of them per request.
const PatchBody = z.union([RenameThreadBody, UpdateStatusBody, UpdateCustomBody]);

// GET /api/threads/[id] — single thread metadata.
export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const row = await getThread(id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(toThreadMetadata(row));
}

// PATCH /api/threads/[id] — rename / archive / unarchive / update custom.
export async function PATCH(req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  let row: Thread | undefined;
  if ("title" in body) {
    row = await renameThread(id, body.title);
  } else if ("status" in body) {
    if (body.status === "archived") await archiveThread(id);
    else await unarchiveThread(id);
    row = await getThread(id);
  } else if ("custom" in body) {
    await updateCustom(id, body.custom);
    row = await getThread(id);
  }
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(toThreadMetadata(row));
}

// DELETE /api/threads/[id] — remove the thread metadata row.
export async function DELETE(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const existing = await getThread(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await deleteThread(id);
  return new NextResponse(null, { status: 204 });
}

function toThreadMetadata(row: Thread) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    lastMessageAt: row.lastMessageAt,
  };
}
