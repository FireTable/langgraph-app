import { NextResponse } from "next/server";

import { R2NotConfiguredError, buildPublicUrl, headObject } from "@/lib/r2/client";
import { getAttachmentForUser, setAttachmentStatus } from "@/lib/attachments/queries";
import { withAuth } from "@/lib/auth/with-auth";

export const POST = withAuth<{ id: string }>(async (_req, { user, params }) => {
  const row = await getAttachmentForUser(params.id, user.id);
  if (!row) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  try {
    const head = await headObject(row.r2Key);
    if (head.contentLength !== row.sizeBytes) {
      return NextResponse.json(
        {
          code: "SIZE_MISMATCH",
          expected: row.sizeBytes,
          actual: head.contentLength,
        },
        { status: 409 },
      );
    }
  } catch (e) {
    if (e instanceof R2NotConfiguredError) {
      return NextResponse.json(
        { code: "ATTACHMENTS_NOT_CONFIGURED", message: e.message },
        { status: 503 },
      );
    }
    // HeadObject 404 means the PUT never landed — surface as 409 so the
    // adapter can prompt the user to retry.
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) {
      return NextResponse.json(
        { code: "UPLOAD_MISSING", message: "Object not found in R2 — re-upload required." },
        { status: 409 },
      );
    }
    throw e;
  }

  const updated = await setAttachmentStatus(row.id, user.id, {
    status: "uploaded",
    confirmedAt: new Date(),
  });

  return NextResponse.json({
    id: row.id,
    publicUrl: buildPublicUrl(row.r2Key),
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: updated?.status ?? "uploaded",
  });
});
