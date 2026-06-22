import { NextResponse } from "next/server";
import { auth } from "./config";
import { headers } from "next/headers";

export type RouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export async function requireSession(): Promise<RouteSession | NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  return session;
}
