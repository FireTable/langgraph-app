import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

function makeChildMock() {
  return {
    output: sandboxChildOutput,
    kill: sandboxChildKill,
    status: Promise.resolve(sandboxChildStatus),
  };
}

beforeEach(() => {
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

describe("getCodeTools", () => {
  it("returns only writeCodeTool when DENO_DEPLOY_TOKEN is unset", async () => {
    delete process.env.DENO_DEPLOY_TOKEN;
    const { getCodeTools, writeCodeTool } = await import("@/backend/tool/code");
    const tools = getCodeTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(writeCodeTool);
  });

  it("returns both tools when DENO_DEPLOY_TOKEN is set", async () => {
    process.env.DENO_DEPLOY_TOKEN = "test-token";
    const { getCodeTools, writeCodeTool, executeCodeTool } = await import("@/backend/tool/code");
    const tools = getCodeTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]).toBe(writeCodeTool);
    expect(tools[1]).toBe(executeCodeTool);
  });
});
