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
import { requireSession } from "@/lib/auth/route-helpers";
import type { Thread } from "@/lib/threads/schema";

type RouteContext = { params: Promise<{ id: string }> };

const PatchBody = z.union([RenameThreadBody, UpdateStatusBody, UpdateCustomBody]);

export async function GET(_req: Request, ctx: RouteContext) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;
  const row = await getThreadForUser(id, session.user.id);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(toThreadMetadata(row));
}

export async function PATCH(req: Request, ctx: RouteContext) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;
  const json = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const existing = await getThreadForUser(id, session.user.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  if ("title" in body) {
    await renameThread(id, body.title);
  } else if ("status" in body) {
    if (body.status === "archived") await archiveThread(id, session.user.id);
    else await unarchiveThread(id, session.user.id);
  } else if ("custom" in body) {
    await updateCustom(id, session.user.id, body.custom);
  }
  const row = await getThreadForUser(id, session.user.id);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(toThreadMetadata(row));
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;
  const existing = await getThreadForUser(id, session.user.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  await deleteThread(id, session.user.id);
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
