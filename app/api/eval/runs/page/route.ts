import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { getRunsByAgentPage } from "@/lib/eval/queries";

export const runtime = "nodejs";

export const GET = withAuth(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const agent = url.searchParams.get("agent");
    const cursor = url.searchParams.get("cursor");
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 5;

    if (!agent || agent.length === 0) {
      return NextResponse.json({ error: "agent is required" }, { status: 400 });
    }

    const page = await getRunsByAgentPage({
      agent,
      cursorId: cursor || null,
      limit,
    });

    return NextResponse.json({
      agent,
      runs: page.runs,
      hasMore: page.hasMore,
      nextCursor: page.nextCursorId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
