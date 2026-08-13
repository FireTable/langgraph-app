import { NextResponse } from "next/server";

import {
  getCanvasSnapshotForUser,
  threadOwnedByUser,
  upsertCanvasSnapshot,
  deleteCanvasSnapshot,
} from "@/lib/canvas/queries";
import { PutCanvasBody } from "@/lib/canvas/validators";
import { withAuth } from "@/lib/auth/with-auth";
import type { CanvasSnapshot } from "@/lib/canvas/schema";
import { EMPTY_DOCUMENT } from "@/lib/canvas/snapshot";

type Params = { threadId: string };

// ponytail: GET returns the saved snapshot, an empty React Flow
// document for an OWNED thread without a snapshot yet, or 404 for a
// thread that doesn't exist / belongs to another user. The 200+empty
// case for "owned + no snapshot" matches what the canvas editor
// already expects on first open (it renders empty + creates the row
// on first save), and avoids the 404 in the network panel /
// observability waterfall for every fresh thread.
//
// Foreign threads still return 404 — the ownership check (`getCanvasSnapshotForUser`
// joins on threads.userId) means a non-owner can't tell whether the
// row exists or not.
export const GET = withAuth<Params>(async (_req, { user, params }) => {
  const [owned, row] = await Promise.all([
    threadOwnedByUser(params.threadId, user.id),
    getCanvasSnapshotForUser(params.threadId, user.id),
  ]);
  if (!owned) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  if (!row) {
    return NextResponse.json({
      threadId: params.threadId,
      document: EMPTY_DOCUMENT,
    });
  }
  return NextResponse.json(toCanvasPayload(row));
});

// ponytail: PUT is upsert. First save creates the row, subsequent saves
// overwrite. Ownership is re-checked inside `upsertCanvasSnapshot` so a
// client can't write to a thread they don't own by guessing the id.
export const PUT = withAuth<Params>(async (req, { user, params }) => {
  const json = await req.json().catch(() => ({}));
  const parsed = PutCanvasBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  try {
    const row = await upsertCanvasSnapshot({
      threadId: params.threadId,
      userId: user.id,
      document: parsed.data.document,
    });
    return NextResponse.json(toCanvasPayload(row));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "thread not owned by user") {
      return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    throw err;
  }
});

export const DELETE = withAuth<Params>(async (_req, { user, params }) => {
  await deleteCanvasSnapshot(params.threadId, user.id);
  return new NextResponse(null, { status: 204 });
});

function toCanvasPayload(row: CanvasSnapshot) {
  return {
    threadId: row.threadId,
    document: row.document,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
