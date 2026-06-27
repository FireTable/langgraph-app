import { NextResponse } from "next/server";

export const runtime = "nodejs";

// ponytail: just reports whether ALCHEMY_API_KEY is set — never the
// value. The frontend uses this for the "🔑 configured / ⚠ not set"
// status badge on the Alchemy admin page.
export function GET() {
  const key = process.env.ALCHEMY_API_KEY;
  return NextResponse.json({ configured: Boolean(key && key.length > 0) });
}
