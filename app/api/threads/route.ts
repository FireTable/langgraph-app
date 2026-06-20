import "server-only";
import { NextResponse } from "next/server";
import { listThreads, createThread } from "@/lib/threads/queries";
import { CreateThreadBody } from "@/lib/threads/validators";
import type { Thread } from "@/lib/threads/schema";

// GET /api/threads — list regular threads for the sidebar.
// Returns { threads: RemoteThreadMetadata[] } in the shape assistant-ui's
// RemoteThreadListAdapter expects.
export async function GET() {
  const rows = await listThreads();
  const list = rows.map(toRemoteMetadata);
  return NextResponse.json({ threads: list });
}

// POST /api/threads — create a new thread. assistant-ui calls this from
// adapter.initialize(); we return { remoteId } so the UI can navigate to it.
export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = CreateThreadBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const row = await createThread(parsed.data.title);
  return NextResponse.json(toRemoteMetadata(row), { status: 201 });
}

function toRemoteMetadata(row: Thread) {
  return {
    status: row.status,
    remoteId: row.id,
    title: row.title,
    externalId: undefined,
  };
}
