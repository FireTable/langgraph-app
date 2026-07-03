import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { deleteMemoryField } from "@/lib/memory/queries";

type KeyParams = { key: string };

// ponytail: FR-014 — the key is a URL segment, not request body, so
// percent-decoding is the route layer's job. After decode we constrain
// to a known-safe charset ([A-Za-z0-9_-], 1..64 chars) to reject `..`
// path-traversal, empty strings, array indices, and percent-encoded
// slashes (`%2F` → `/` is decoded before the regex sees it).
const KEY_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export const DELETE = withAuth<KeyParams>(async (_req, { user, params }) => {
  const key = decodeURIComponent(params.key);
  if (!KEY_REGEX.test(key)) {
    return NextResponse.json({ code: "BAD_KEY" }, { status: 400 });
  }
  const deleted = await deleteMemoryField(user.id, key);
  if (deleted === null) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deletedKey: deleted });
});
