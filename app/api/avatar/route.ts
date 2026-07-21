import { NextResponse } from "next/server";

import { R2NotConfiguredError, deleteObject, getR2PublicBaseUrl } from "@/lib/r2/client";
import { r2Keys } from "@/lib/r2/keys";
import { withAuth } from "@/lib/auth/with-auth";

// ponytail: avatars have no DB row, so nothing sweeps the old R2 object when
// the user deletes or replaces their avatar — it would leak forever at its
// public URL. This route deletes the object behind an avatar URL, owner-
// scoped: the key must be the user's own avatar slot. External avatar URLs
// (a github/google-hosted image) aren't ours → 204 no-op. Idempotent: an
// already-gone object is a success.

function notConfiguredResponse(): NextResponse {
  return NextResponse.json(
    {
      code: "AVATAR_UPLOADS_NOT_CONFIGURED",
      message: "Set the R2_* env vars to enable avatar uploads (see docs/ATTACHMENTS.md).",
    },
    { status: 503 },
  );
}

export const DELETE = withAuth(async (req, { user }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "BAD_REQUEST", error: "invalid JSON" }, { status: 400 });
  }

  const url = (body as { url?: unknown })?.url;
  if (typeof url !== "string" || url.length === 0) {
    return NextResponse.json({ code: "BAD_REQUEST", error: "url required" }, { status: 400 });
  }

  let base: string;
  try {
    base = getR2PublicBaseUrl();
  } catch (e) {
    if (e instanceof R2NotConfiguredError) return notConfiguredResponse();
    throw e;
  }

  // Not one of our R2 objects (e.g. an OAuth-hosted avatar) → nothing to do.
  if (!url.startsWith(`${base}/`)) return new NextResponse(null, { status: 204 });

  const key = url.slice(base.length + 1);
  // ponytail: avatar key is fixed-slot `u/<userId>/avatar.png`.
  // Owner-scoped: key must equal the user's slot. Any other key
  // (including other users' avatar slots) → 403.
  const avatarKey = r2Keys().avatar({ userId: user.id });
  if (key !== avatarKey) {
    return NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
  }

  await deleteObject(key).catch(() => undefined);
  return new NextResponse(null, { status: 204 });
});
