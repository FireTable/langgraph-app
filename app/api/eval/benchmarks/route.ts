import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import {
  createBenchmark,
  deleteBenchmark,
  getAllBenchmarksWithLatestJudgment,
  updateRubricCriteria,
} from "@/lib/eval/queries";

export const runtime = "nodejs";

export const GET = withAuth(async () => {
  try {
    const benchmarks = await getAllBenchmarksWithLatestJudgment();
    return NextResponse.json({ benchmarks });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

export const POST = withAuth(async (req) => {
  try {
    const body = (await req.json()) as {
      action: "create" | "delete" | "update_rubric";
      id?: string;
      agent?: string;
      title?: string;
      inputPrompt?: string;
      expectedOutput?: string;
      rubricId?: string;
      criteria?: Array<{ key: string; description: string; weight?: number }>;
      name?: string;
    };

    if (body.action === "update_rubric") {
      if (!body.rubricId || !body.criteria) {
        return NextResponse.json({ error: "rubricId and criteria are required" }, { status: 400 });
      }
      await updateRubricCriteria({
        rubricId: body.rubricId,
        name: body.name,
        criteria: body.criteria,
      });
      return NextResponse.json({ success: true });
    }

    if (body.action === "create") {
      if (!body.agent || !body.title || !body.inputPrompt) {
        return NextResponse.json(
          { error: "agent, title, and inputPrompt are required" },
          { status: 400 },
        );
      }

      const benchmark = await createBenchmark({
        agent: body.agent,
        title: body.title,
        inputPrompt: body.inputPrompt,
        expectedOutput: body.expectedOutput ?? null,
      });
      return NextResponse.json({ benchmark });
    }

    if (body.action === "delete") {
      if (!body.id) {
        return NextResponse.json({ error: "id is required for deletion" }, { status: 400 });
      }
      await deleteBenchmark(body.id);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
