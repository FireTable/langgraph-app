import "server-only";
import { NextResponse } from "next/server";
import { listThreads, createThread } from "@/lib/threads/queries";
import { CreateThreadBody } from "@/lib/threads/validators";
import type { Thread } from "@/lib/threads/schema";

// GET /api/threads — list regular threads for the sidebar.
export async function GET() {
  const rows = await listThreads();
  const list = rows.map(toThreadMetadata);
  return NextResponse.json({ threads: list });
}

// POST /api/threads — create a new thread.
export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = CreateThreadBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const row = await createThread(parsed.data.title);
  return NextResponse.json(toThreadMetadata(row), { status: 201 });
}

// Our own ThreadMetadata shape. The frontend `lib/threads/adapter.ts`
// translates this to assistant-ui's RemoteThreadMetadata (with remoteId +
// externalId), so this route never speaks assistant-ui's vocabulary.
function toThreadMetadata(row: Thread) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    lastMessageAt: row.lastMessageAt,
  };
}
