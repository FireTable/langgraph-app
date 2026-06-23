import { NextResponse } from "next/server";

import { listThreadsForUser, createThread } from "@/lib/threads/queries";
import { CreateThreadBody } from "@/lib/threads/validators";
import { langGraphClient } from "@/lib/langgraph/client";
import { withAuth } from "@/lib/auth/with-auth";
import type { Thread } from "@/lib/threads/schema";

export const GET = withAuth(async (_req, { user }) => {
  const rows = await listThreadsForUser(user.id);
  return NextResponse.json({ threads: rows.map(toThreadMetadata) });
});

export const POST = withAuth(async (req, { user }) => {
  const json = await req.json().catch(() => ({}));
  const parsed = CreateThreadBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  const row = await createThread(user.id, parsed.data.title);
  await langGraphClient.threads.create({ threadId: row.id, ifExists: "do_nothing" });
  return NextResponse.json(toThreadMetadata(row), { status: 201 });
});

function toThreadMetadata(row: Thread) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    lastMessageAt: row.lastMessageAt,
  };
}
