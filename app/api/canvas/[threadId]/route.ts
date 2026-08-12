import { NextResponse } from "next/server";

import {
  getCanvasSnapshotForUser,
  upsertCanvasSnapshot,
  deleteCanvasSnapshot,
} from "@/lib/canvas/queries";
import { PutCanvasBody } from "@/lib/canvas/validators";
import { withAuth } from "@/lib/auth/with-auth";
import type { CanvasSnapshot } from "@/lib/canvas/schema";

type Params = { threadId: string };

// ponytail: GET returns either the saved snapshot or 404. A missing row
// is indistinguishable from "not yours" — both return 404 to prevent
// enumeration of other users' thread ids.
export const GET = withAuth<Params>(async (_req, { user, params }) => {
  const row = await getCanvasSnapshotForUser(params.threadId, user.id);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
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
