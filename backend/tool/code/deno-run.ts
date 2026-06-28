// ponytail: HTTP client is a private detail of execute_code. One consumer
// in this folder, no separate file. The @deno/sandbox SDK handles the
// WebSocket to Deno Deploy's microVMs. We use `sandbox.spawn(...)` +
// child output capture instead of `sandbox.deno.eval()` so console.log
// output is returned to the model — eval() only returns the last
// expression value, which means a script that ends with `console.log(...)`
// shows up as `null` and the model has to hallucinate what got printed.
// We route by language: typescript / javascript → `deno eval` (Deno's
// runtime is JS+TS); python → `python3 -c` (Python 3 is preinstalled on
// the sandbox image). Bash / node aren't routed — node is a deno wrapper
// and bash is a footgun the model can already reach via
// `Deno.Command("bash", ...)` if it really wants.
//
// Deno's `--no-color`-less output ships ANSI color escapes (e.g.
// `\x1b[31mError\x1b[0m`). They render fine in a real terminal but show
// up as literal garbage (`[@1m[31m...`) in any HTML/JS consumer — see the
// execute-code-result card. `stripAnsi` below scrubs them at the boundary
// so the result type stays a clean string. Pattern matches the CSI form
// (ESC `[` then params + final byte); CARET form (`\x1b]…\x07`) is rare
// enough in Deno's output that we ignore it for now.

import { Sandbox } from "@deno/sandbox";

// ponytail: scrub CSI ANSI escapes (\x1b[...m etc). Deno's stderr
// includes color codes by default; in HTML/JS they show up as
// `[@1m[31m...` (the ESC is rendered as a control char that some
// renderers display as @). Strip at the boundary so the result is
// plain text the frontend can wrap with whitespace-pre-wrap.
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "");
}

const DEFAULT_TIMEOUT_MS = 10_000;

export type DenoRunResult =
  | { ok: true; stdout: string; stderr: string; result?: unknown }
  | { ok: false; stdout?: string; stderr?: string; error: string };

export type DenoRunOptions = {
  timeoutMs?: number;
  /** Forwarded to the child process's stdin. Strings are written verbatim;
   *  other values are JSON-serialized. When undefined, stdin is closed
   *  before the child starts. */
  input?: unknown;
  language?: "typescript" | "javascript" | "python";
};

export async function denoRun(code: string, opts: DenoRunOptions = {}): Promise<DenoRunResult> {
  const token = process.env.DENO_DEPLOY_TOKEN;
  if (!token) {
    return {
      ok: false,
      error:
        "DENO_DEPLOY_TOKEN is not set. Create a workspace token at https://console.deno.com/ (Sandbox tab) and set it in .env.local.",
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const org = process.env.DENO_DEPLOY_ORG;

  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | undefined;
  try {
    // ponytail: a new microVM per call. Latency ~1-2s. Good enough for an
    // agent tool where the user is already waiting on the model. If we
    // need lower latency later, persist a sandbox via Sandbox.connect({id}).
    sandbox = await Sandbox.create({
      token,
      ...(org ? { org } : {}),
      timeout: `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
    });

    const language = opts.language ?? "typescript";
    const hasInput = opts.input !== undefined;
    const spawnSpec =
      language === "python"
        ? { cmd: "python3", args: ["-c", code] as string[] }
        : { cmd: "deno", args: ["eval", code] as string[] };

    // ponytail: stdin is "null" when there's no input so the child sees
    // an immediately-closed read end (and any read() returns 0). When
    // input is provided, leave stdin "piped" and write + close it below.
    const child = await sandbox.spawn(spawnSpec.cmd, {
      args: spawnSpec.args,
      stdin: hasInput ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    });

    // ponytail: race the SDK's output() against a wall-clock timeout.
    // If the timeout wins, kill the child so the sandbox doesn't leak
    // a hung process (the sandbox-level timeout eventually reclaims it,
    // but that's measured in seconds and burns CPU credits in the meantime).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
    });

    let output: Awaited<ReturnType<typeof child.output>>;
    try {
      if (hasInput) {
        // ponytail: string → verbatim, anything else → JSON. The user picks
        // a payload shape and the child decides how to read it
        // (e.g. `await new Response(Deno.stdin.readable).text()`,
        // `sys.stdin.read()`). Stream must be closed manually per SDK docs.
        const payload = typeof opts.input === "string" ? opts.input : JSON.stringify(opts.input);
        // ! — the `stdin: hasInput ? "piped" : "null"` branch above guarantees
        // child.stdin is non-null when hasInput is true. The SDK type widens
        // to `WritableStream | null` because the getter reflects whatever
        // option was passed at spawn time.
        const writer = child.stdin!.getWriter();
        try {
          await Promise.race([writer.write(new TextEncoder().encode(payload)), timeoutPromise]);
          await Promise.race([writer.close(), timeoutPromise]);
        } finally {
          writer.releaseLock();
        }
      }
      output = await Promise.race([child.output(), timeoutPromise]);
    } catch (e) {
      if (e instanceof Error && e.message === "Timeout") {
        await child.kill("SIGKILL").catch(() => {});
        return { ok: false, error: `Timeout after ${timeoutMs}ms` };
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const stdout = stripAnsi(output.stdoutText ?? "");
    const stderr = stripAnsi(output.stderrText ?? "");

    if (!output.status.success) {
      return {
        ok: false,
        stdout,
        stderr,
        error: stderr.trim() || `Exit ${output.status.code ?? "unknown"}`,
      };
    }

    return { ok: true, stdout, stderr, result: stdout };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sandbox exec failed";
    return { ok: false, error: message };
  } finally {
    try {
      await sandbox?.close();
    } catch {
      // best effort
    }
  }
}
