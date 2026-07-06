// Step 2 of the code flow — actually run the code the user approved in
// write_code. Lazy-registered: only present in the agent's tool list
// when DENO_DEPLOY_TOKEN is set. The model can still call write_code
// without it; on Run, the model is expected to surface a graceful
// fallback in prose (the interrupt's resume path still works).

import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { denoRun } from "@/backend/tool/code/deno-run";

export const EXECUTE_CODE_TOOL_NAME = "execute_code";

export const executeCodeTool: StructuredTool | null = process.env.DENO_DEPLOY_TOKEN
  ? tool(
      async ({
        code,
        input,
        timeoutMs,
        language,
      }: {
        code: string;
        input?: unknown;
        timeoutMs?: number;
        language?: "typescript" | "javascript" | "python";
      }) => {
        return JSON.stringify(await denoRun(code, { input, timeoutMs, language }));
      },
      {
        name: EXECUTE_CODE_TOOL_NAME,
        description:
          "STEP 2 of the code flow — run code in a Deno Deploy Sandbox (Firecracker microVM). Sandbox is ephemeral and isolated from the host, but fetch, the file system, and env inside the VM work normally. Supported languages: typescript (default — Deno eval), javascript (also Deno eval), python (python3 -c, stdlib only). Returns { ok, stdout, stderr, result } on success or { ok: false, error } on failure. `result` is the captured stdout (so console.log output is included). Use this AFTER write_code returns { action: 'run', code } (pass that code AND the same `language`) OR directly for one-shot computations. Do NOT call this to re-display the same code — the user has already seen it via the write_code editor card.",
        schema: z.object({
          code: z
            .string()
            .min(1)
            .max(50_000)
            .describe(
              "Source code in the chosen language. For typescript/javascript: Deno-compatible — no CommonJS, no browser APIs. For python: standard library only.",
            ),
          input: z
            .unknown()
            .optional()
            .describe(
              "Optional stdin payload. Strings are written verbatim; other values are JSON-serialized. The child reads it via `Deno.stdin.readable` (TS/JS) or `sys.stdin.read()` (Python). When omitted, stdin is closed before the child starts.",
            ),
          language: z
            .enum(["typescript", "javascript", "python"])
            .optional()
            .describe("Code language. Defaults to typescript."),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .max(60_000)
            .optional()
            .describe("Max execution time in ms. Defaults to 10000, max 60000."),
        }),
      },
    )
  : null;

// ponytail: CODE_TOOLS aggregation moved to backend/tool/index.ts so all
// conditional tool registration lives in one place.
