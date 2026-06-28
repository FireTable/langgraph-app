// Step 1 of the code flow — the model proposes code, the user reviews it
// in the editor card, and the tool's resume returns the (possibly edited)
// code. Doesn't run anything itself; that lives in execute-code.ts.

import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";

export type WriteCodeResume =
  | { action: "run"; code: string; language?: string }
  | { action: "cancel" };

export const WRITE_CODE_TOOL_NAME = "write_code";

export const writeCodeTool = tool(
  async ({ code, language }: { code: string; language?: string }) => {
    const picked = (await interrupt({
      ui: WRITE_CODE_TOOL_NAME,
      data: { code, language: language ?? "typescript" },
      message: "Review the code, then run or cancel.",
    })) as WriteCodeResume | null;

    if (!picked || picked.action === "cancel") {
      return JSON.stringify({ action: "cancelled" });
    }
    // ponytail: echo back `language` so the model can pass it on to
    // execute_code without having to remember the original write_code args.
    return JSON.stringify({
      action: "run",
      code: picked.code,
      ...(picked.language ? { language: picked.language } : {}),
    });
  },
  {
    name: WRITE_CODE_TOOL_NAME,
    description:
      "STEP 1 of the code flow — propose code to the user. PAUSES the turn and shows an editor with a Run button. On the next pass the tool returns one of: { action: 'run', code } (user clicked Run — IMMEDIATELY call execute_code with that code AND the same `language`; do NOT call write_code again) or { action: 'cancelled' } (do not call execute_code, just acknowledge). Use this BEFORE execute_code for any non-trivial code; for one-liners, skip write_code and call execute_code directly. Supported languages: typescript (default — Deno native), javascript (also Deno), python (sandbox has Python 3 preinstalled).",
    schema: z.object({
      code: z
        .string()
        .min(1)
        .max(50_000)
        .describe(
          "Source code. Deno-compatible when language is typescript or javascript — no CommonJS, no browser APIs. fetch and the file system are available (sandbox is a real Deno runtime in a Firecracker microVM). For python, standard library only (no extra pip installs in the sandbox).",
        ),
      language: z
        .enum(["typescript", "javascript", "python"])
        .optional()
        .describe("Code language — typescript, javascript, or python. Defaults to typescript."),
    }),
  },
);
