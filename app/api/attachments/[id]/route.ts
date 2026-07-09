import { NextResponse } from "next/server";

import { R2NotConfiguredError, deleteObject } from "@/lib/r2/client";
import { deleteAttachmentForUser } from "@/lib/attachments/queries";
import { withAuth } from "@/lib/auth/with-auth";

// DELETE /api/attachments/[id] — remove the row + best-effort R2 object.
// Idempotent: deleting an already-missing id returns 204 the same way.
export const DELETE = withAuth<{ id: string }>(async (_req, { user, params }) => {
  const row = await deleteAttachmentForUser(params.id, user.id);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  try {
    await deleteObject(row.r2Key);
  } catch (e) {
    if (e instanceof R2NotConfiguredError) {
      return NextResponse.json(
        { code: "ATTACHMENTS_NOT_CONFIGURED", message: e.message },
        { status: 503 },
      );
    }
    // R2 404 on delete is fine — the row is gone either way.
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status && status !== 404) throw e;
  }

  return new NextResponse(null, { status: 204 });
});
