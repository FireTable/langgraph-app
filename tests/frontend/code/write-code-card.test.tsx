import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const sendCommand = vi.fn();

vi.mock("@assistant-ui/react-langgraph", () => ({
  useLangGraphSendCommand: () => sendCommand,
}));

import { WriteCodeCard } from "@/components/tool-ui/code/write-code-card";

const args = { code: "const x = 1;\nconsole.log(x);", language: "typescript" };
// ponytail: WriteCodeCard is a ComponentClass (ToolCallMessagePartComponent
// is a class), so we type the test props as a structural cast — the
// runtime contract is what we exercise, the SDK's full prop union is
// wider than this test needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baseProps: any = {
  toolCallId: "tc1",
  args,
  argsText: JSON.stringify(args),
  result: undefined,
  status: undefined,
  addResult: () => {},
  resume: undefined,
  interrupt: undefined,
  toolName: "write_code",
};

beforeEach(() => {
  sendCommand.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("WriteCodeCard", () => {
  it("renders the code in a code block by default (markdown view)", () => {
    render(<WriteCodeCard {...baseProps} />);
    // The default surface is the markdown CodeBlock. prism-react-renderer
    // tokenizes the source into per-token spans, so we look for the
    // language label (single text) and the code text by walking the
    // <pre>'s textContent rather than by getByText (which would not
    // match a text broken up across token spans).
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("typescript")).toBeInTheDocument();
    const pre = document.querySelector('[data-slot="write-code-card"] pre') as HTMLElement | null;
    expect(pre?.textContent).toContain("const x = 1;");
  });

  it("calls sendCommand with action: run + the args code + language on Run in sandbox click", () => {
    render(<WriteCodeCard {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Run in sandbox/ }));
    expect(sendCommand).toHaveBeenCalledWith({
      resume: { action: "run", code: args.code, language: "typescript" },
    });
  });

  it("propagates language: python in the run resume", () => {
    render(
      <WriteCodeCard
        {...baseProps}
        args={{ code: "import sys\nprint(sys.version)", language: "python" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Run in sandbox/ }));
    expect(sendCommand).toHaveBeenCalledWith({
      resume: { action: "run", code: "import sys\nprint(sys.version)", language: "python" },
    });
  });

  it("calls sendCommand with action: cancel on Skip run click", () => {
    render(<WriteCodeCard {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip run" }));
    expect(sendCommand).toHaveBeenCalledWith({ resume: { action: "cancel" } });
  });

  it("hides the action buttons once the result resolves", () => {
    const resolvedProps = {
      ...baseProps,
      result: JSON.stringify({ action: "run", code: args.code, language: "typescript" }),
    };
    render(<WriteCodeCard {...resolvedProps} />);
    expect(screen.queryByRole("button", { name: /Run in sandbox/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip run" })).not.toBeInTheDocument();
    expect(screen.getByText(/Run requested|Done/)).toBeInTheDocument();
  });
});
