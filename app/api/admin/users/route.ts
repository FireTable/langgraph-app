import { NextResponse } from "next/server";

import { getAdminUsersList } from "@/lib/auth/user-queries";
import { withAuth } from "@/lib/auth/with-auth";

// ponytail: list every user with their role snapshot, avatar, and credit/token usage.
export const GET = withAuth({ role: "admin" }, async () => {
  const users = await getAdminUsersList();

  return NextResponse.json({ users });
});
