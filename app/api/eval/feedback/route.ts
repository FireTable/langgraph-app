import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { submitFeedback } from "@/lib/eval/queries";

export const runtime = "nodejs";

export const POST = withAuth(async (req, { user }) => {
  try {
    const body = (await req.json()) as {
      runId?: string;
      rating?: number;
      source?: string;
      reason?: string;
    };

    if (!body.runId || typeof body.rating !== "number") {
      return NextResponse.json(
        { error: "runId and numeric rating (1-5) are required" },
        { status: 400 },
      );
    }

    await submitFeedback({
      runId: body.runId,
      userId: user.id,
      rating: body.rating,
      source: body.source ?? "user_online",
      reason: body.reason,
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
