import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { withAuth } from "@/lib/auth/with-auth";
import { findKbFolderByName, insertKbFolder } from "@/lib/kb/queries";

// ponytail: Settings → KB → "New Folder" modal endpoint. Same UNIQUE
// (user_id, name) constraint as the auto-created "Attachments" folder,
// so concurrent creates collapse via the 23505 retry path inside
// ensureDefaultKbFolder. We don't use that helper here because the UI
// needs to know whether the folder already exists (409) vs. was just
// created (201) — that distinction is lost behind ensureDefaultKbFolder.

const Schema = z.object({
  name: z.string().min(1).max(64).trim(),
});

export const POST = withAuth(async (req, { user }) => {
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ code: "INVALID_NAME" }, { status: 400 });
  }
  const { name } = body.data;

  const existing = await findKbFolderByName(user.id, name);
  if (existing) {
    return NextResponse.json({ code: "DUPLICATE", folder: existing }, { status: 409 });
  }

  try {
    const folder = await insertKbFolder({
      id: `f-${randomUUID()}`,
      userId: user.id,
      name,
    });
    return NextResponse.json({ folder }, { status: 201 });
  } catch (err) {
    // Race with another tab creating the same folder: 23505 → re-read.
    if ((err as { code?: string }).code === "23505") {
      const again = await findKbFolderByName(user.id, name);
      if (again) {
        return NextResponse.json({ code: "DUPLICATE", folder: again }, { status: 409 });
      }
    }
    console.error("POST /api/kb/folders failed", err);
    return NextResponse.json({ code: "INTERNAL" }, { status: 500 });
  }
});
