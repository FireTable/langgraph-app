import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type WritableStream<T> = globalThis.WritableStream<T>;

vi.mock("@langchain/langgraph", async () => {
  const actual =
    await vi.importActual<typeof import("@langchain/langgraph")>("@langchain/langgraph");
  return {
    ...actual,
    interrupt: vi.fn(),
  };
});

const sandboxCreate = vi.fn();
const sandboxSpawn = vi.fn();
const sandboxChildOutput = vi.fn();
const sandboxChildKill = vi.fn().mockResolvedValue(undefined);
const sandboxChildStatus = { success: true, code: 0 };
const sandboxClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@deno/sandbox", () => {
  return {
    Sandbox: {
      create: (...args: unknown[]) => sandboxCreate(...args),
    },
  };
});

const { interrupt: interruptMock } = await import("@langchain/langgraph");

function makeChildMock(stdinStream: WritableStream<Uint8Array<ArrayBuffer>> | null = null) {
  // ponytail: the SDK's ChildProcess type narrows `stdin` to null when
  // `stdin: "null"` was passed at spawn, so the default is null. Tests
  // that exercise the `stdin: "piped"` branch override this with a
  // recording stream (see the `it("pipes input to …")` block).
  return {
    output: sandboxChildOutput,
    kill: sandboxChildKill,
    status: Promise.resolve(sandboxChildStatus),
    stdin: stdinStream,
  };
}

function makeRecordingStdin() {
  const chunks: Uint8Array[] = [];
  const writer = {
    write: vi.fn(async (chunk: Uint8Array) => {
      chunks.push(chunk);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn(),
  };
  return {
    stream: { getWriter: () => writer } as unknown as WritableStream<Uint8Array<ArrayBuffer>>,
    chunks,
    writer,
  };
}

beforeEach(() => {
  // ponytail: clear FIRST so the "unset" test isn't poisoned by
  // `loadEnvConfig` reading .env.local in tests/setup.ts. afterEach
  // alone wouldn't catch the first test in the file (no previous
  // afterEach ran). The other tests below re-set the env explicitly.
  delete process.env.DENO_DEPLOY_TOKEN;
  delete process.env.DENO_DEPLOY_ORG;
  sandboxCreate.mockReset();
  sandboxSpawn.mockReset();
  sandboxChildOutput.mockReset();
  sandboxChildKill.mockReset();
  sandboxChildKill.mockResolvedValue(undefined);
  sandboxClose.mockReset();
  (interruptMock as unknown as ReturnType<typeof vi.fn>).mockReset();
  vi.resetModules();
  // Default: Sandbox.create returns a handle with .spawn + .close.
  sandboxCreate.mockResolvedValue({
    spawn: sandboxSpawn,
    close: sandboxClose,
  });
  sandboxSpawn.mockResolvedValue(makeChildMock());
});

afterEach(() => {
  delete process.env.DENO_DEPLOY_TOKEN;
  delete process.env.DENO_DEPLOY_ORG;
});

describe("denoRun", () => {
  it("returns a config error when DENO_DEPLOY_TOKEN is unset", async () => {
    const { denoRun } = await import("@/backend/tool/code");
    const result = await denoRun("1 + 1");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/DENO_DEPLOY_TOKEN/);
    }
    expect(sandboxCreate).not.toHaveBeenCalled();
  });

  it("spawns `deno eval`, captures stdout, and returns it as result", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    sandboxChildOutput.mockResolvedValueOnce({
      status: { success: true, code: 0 },
      stdoutText: "2\n",
      stderrText: "",
    });

    const { denoRun } = await import("@/backend/tool/code");
    const result = await denoRun("1 + 1");

    expect(sandboxCreate).toHaveBeenCalledTimes(1);
    const [createOpts] = sandboxCreate.mock.calls[0];
    expect(createOpts.token).toBe("test-token");
    expect(createOpts.org).toBeUndefined();
    expect(sandboxSpawn).toHaveBeenCalledWith("deno", {
      args: ["eval", "1 + 1"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    expect(sandboxClose).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, stdout: "2\n", stderr: "", result: "2\n" });
  });

  it("passes org to Sandbox.create when DENO_DEPLOY_ORG is set", async () => {
    process.env.DENO_DEPLOY_TOKEN = "ddo_test-token";
    process.env.DENO_DEPLOY_ORG = "my-org";
    sandboxChildOutput.mockResolvedValueOnce({
      status: { success: true, code: 0 },
      stdoutText: "ok",
      stderrText: "",
    });

    const { denoRun } = await import("@/backend/tool/code");
    await denoRun("1");

    const [createOpts] = sandboxCreate.mock.calls[0];
    expect(createOpts.token).toBe("ddo_test-token");
    expect(createOpts.org).toBe("my-org");
  });

  it("returns an error result when the process exits non-zero", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    sandboxChildOutput.mockResolvedValueOnce({
      status: { success: false, code: 1 },
      stdoutText: "",
      stderrText: "ReferenceError: x is not defined\n    at eval",
    });

    const { denoRun } = await import("@/backend/tool/code");
    const result = await denoRun("return x");

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/ReferenceError/);
      expect(result.stderr).toMatch(/ReferenceError/);
    }
  });

  it("returns a timeout error and kills the child when eval exceeds timeoutMs", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    sandboxChildOutput.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({} as never), 200)),
    );

    const { denoRun } = await import("@/backend/tool/code");
    const result = await denoRun("while (true) {}", { timeoutMs: 50 });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/Timeout/);
    }
    expect(sandboxChildKill).toHaveBeenCalledWith("SIGKILL");
  });

  it("pipes string input verbatim to the child stdin and closes it", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    const stdin = makeRecordingStdin();
    sandboxSpawn.mockResolvedValueOnce(makeChildMock(stdin.stream));
    sandboxChildOutput.mockResolvedValueOnce({
      status: { success: true, code: 0 },
      stdoutText: "ok",
      stderrText: "",
    });

    const { denoRun } = await import("@/backend/tool/code");
    const result = await denoRun("console.log('x')", { input: "hello" });

    expect(sandboxSpawn).toHaveBeenCalledWith("deno", expect.objectContaining({ stdin: "piped" }));
    expect(stdin.writer.write).toHaveBeenCalledTimes(1);
    const written = stdin.writer.write.mock.calls[0][0] as Uint8Array;
    expect(new TextDecoder().decode(written)).toBe("hello");
    expect(stdin.writer.close).toHaveBeenCalledTimes(1);
    expect(stdin.writer.releaseLock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("JSON-serializes non-string input before writing to stdin", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    const stdin = makeRecordingStdin();
    sandboxSpawn.mockResolvedValueOnce(makeChildMock(stdin.stream));
    sandboxChildOutput.mockResolvedValueOnce({
      status: { success: true, code: 0 },
      stdoutText: "ok",
      stderrText: "",
    });

    const { denoRun } = await import("@/backend/tool/code");
    await denoRun("console.log(input)", { input: { count: 3, ids: [1, 2] } });

    const written = stdin.writer.write.mock.calls[0][0] as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(written))).toEqual({ count: 3, ids: [1, 2] });
  });

  it('uses stdin: "null" (does not write) when no input is provided', async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    sandboxChildOutput.mockResolvedValueOnce({
      status: { success: true, code: 0 },
      stdoutText: "ok",
      stderrText: "",
    });

    const { denoRun } = await import("@/backend/tool/code");
    await denoRun("1 + 1");

    expect(sandboxSpawn).toHaveBeenCalledWith("deno", expect.objectContaining({ stdin: "null" }));
  });
});

describe("writeCodeTool (interrupt-driven)", () => {
  it("pauses with ui: write_code and returns the run payload from the card", async () => {
    (interruptMock as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      action: "run",
      code: "console.log('hi')",
    });

    const { writeCodeTool } = await import("@/backend/tool/code");
    const result = await writeCodeTool.invoke({
      code: "console.log('hi')",
      language: "typescript",
    });

    expect(interruptMock).toHaveBeenCalledWith({
      ui: "write_code",
      data: { code: "console.log('hi')", language: "typescript" },
      message: "Review the code, then run or cancel.",
    });
    expect(JSON.parse(result as string)).toEqual({
      action: "run",
      code: "console.log('hi')",
    });
  });

  it("defaults language to typescript when omitted", async () => {
    (interruptMock as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      action: "run",
      code: "x",
    });

    const { writeCodeTool } = await import("@/backend/tool/code");
    await writeCodeTool.invoke({ code: "x" });

    const data = (interruptMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data.language).toBe("typescript");
  });

  it("returns cancelled when the user cancels", async () => {
    (interruptMock as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      action: "cancel",
    });

    const { writeCodeTool } = await import("@/backend/tool/code");
    const result = await writeCodeTool.invoke({ code: "x" });
    expect(JSON.parse(result as string)).toEqual({ action: "cancelled" });
  });

  it("returns cancelled when the resume is null", async () => {
    (interruptMock as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    const { writeCodeTool } = await import("@/backend/tool/code");
    const result = await writeCodeTool.invoke({ code: "x" });
    expect(JSON.parse(result as string)).toEqual({ action: "cancelled" });
  });

  it("rejects empty code at the schema layer", async () => {
    const { writeCodeTool } = await import("@/backend/tool/code");
    await expect(writeCodeTool.invoke({ code: "" })).rejects.toThrow();
  });
});

describe("executeCodeTool (lazy)", () => {
  it("is null when DENO_DEPLOY_TOKEN is unset", async () => {
    delete process.env.DENO_DEPLOY_TOKEN;
    const { executeCodeTool } = await import("@/backend/tool/code");
    expect(executeCodeTool).toBeNull();
  });

  it("is defined when DENO_DEPLOY_TOKEN is set", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    const { executeCodeTool } = await import("@/backend/tool/code");
    expect(executeCodeTool).not.toBeNull();
  });

  it("calls denoRun and returns serialized result with stdout as result", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    sandboxChildOutput.mockResolvedValueOnce({
      status: { success: true, code: 0 },
      stdoutText: "F(0)=0\nF(1)=1\n",
      stderrText: "",
    });

    const { executeCodeTool } = await import("@/backend/tool/code");
    const result = await executeCodeTool!.invoke({
      code: "for (let i = 0; i < 2; i++) console.log(`F(${i}) = ${i}`);",
    });

    expect(JSON.parse(result as string)).toEqual({
      ok: true,
      stdout: "F(0)=0\nF(1)=1\n",
      stderr: "",
      result: "F(0)=0\nF(1)=1\n",
    });
  });
});

describe("CODE_TOOLS", () => {
  // ponytail: aggregation lives in backend/tool/index.ts (CLAUDE.md rule
  // #10) — this test guards the conditional spread on executeCodeTool
  // (writeCodeTool + saveMemoryTool are unconditional). We assert by
  // membership rather than length so future unconditional additions
  // don't break the test.
  it("omits executeCodeTool when DENO_DEPLOY_TOKEN is unset", async () => {
    delete process.env.DENO_DEPLOY_TOKEN;
    const { CODE_TOOLS } = await import("@/backend/tool");
    const { writeCodeTool, executeCodeTool } = await import("@/backend/tool/code");
    expect(CODE_TOOLS).toContain(writeCodeTool);
    expect(CODE_TOOLS).not.toContain(executeCodeTool);
  });

  it("includes executeCodeTool when DENO_DEPLOY_TOKEN is set", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    const { CODE_TOOLS } = await import("@/backend/tool");
    const { writeCodeTool, executeCodeTool } = await import("@/backend/tool/code");
    expect(CODE_TOOLS).toContain(writeCodeTool);
    expect(CODE_TOOLS).toContain(executeCodeTool);
  });
});
