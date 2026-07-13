import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getThreadForUser,
  renameThread,
  archiveThread,
  unarchiveThread,
  updateCustom,
  deleteThread,
  purgeThreadState,
} from "@/lib/threads/queries";
import { RenameThreadBody, UpdateStatusBody, UpdateCustomBody } from "@/lib/threads/validators";
import { withAuth } from "@/lib/auth/with-auth";
import type { Thread } from "@/lib/threads/schema";

type IdParams = { id: string };

const PatchBody = z.union([RenameThreadBody, UpdateStatusBody, UpdateCustomBody]);

export const GET = withAuth<IdParams>(async (_req, { user, params }) => {
  const row = await getThreadForUser(params.id, user.id);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(toThreadMetadata(row));
});

export const PATCH = withAuth<IdParams>(async (req, { user, params }) => {
  const json = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const existing = await getThreadForUser(params.id, user.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  if ("title" in body) {
    await renameThread(params.id, body.title);
  } else if ("status" in body) {
    if (body.status === "archived") await archiveThread(params.id, user.id);
    else await unarchiveThread(params.id, user.id);
  } else if ("custom" in body) {
    await updateCustom(params.id, user.id, body.custom);
  }
  const row = await getThreadForUser(params.id, user.id);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(toThreadMetadata(row));
});

export const DELETE = withAuth<IdParams>(async (_req, { user, params }) => {
  const existing = await getThreadForUser(params.id, user.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  // ponytail: sweep per-thread state (checkpointer rows + store summaries)
  // BEFORE dropping the threads row. The threads row's FK cascade picks up
  // observability_spans; the FK-less checkpointer/store tables don't, so they
  // need an explicit call. Best-effort — see `purgeThreadState` for rationale.
  await purgeThreadState(params.id, user.id);
  await deleteThread(params.id, user.id);
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
