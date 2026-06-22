import { NextResponse } from "next/server";
import { listThreadsForUser, createThread } from "@/lib/threads/queries";
import { CreateThreadBody } from "@/lib/threads/validators";
import { langGraphClient } from "@/lib/langgraph/client";
import { requireSession } from "@/lib/auth/route-helpers";
import type { Thread } from "@/lib/threads/schema";

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const rows = await listThreadsForUser(session.user.id);
  return NextResponse.json({ threads: rows.map(toThreadMetadata) });
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const json = await req.json().catch(() => ({}));
  const parsed = CreateThreadBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  const row = await createThread(session.user.id, parsed.data.title);
  await langGraphClient.threads.create({ threadId: row.id, ifExists: "do_nothing" });
  return NextResponse.json(toThreadMetadata(row), { status: 201 });
}

function toThreadMetadata(row: Thread) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    lastMessageAt: row.lastMessageAt,
  };
}
