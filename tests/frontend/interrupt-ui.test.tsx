import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@assistant-ui/react-langgraph", () => ({
  useLangGraphInterruptState: vi.fn(),
  useLangGraphSendCommand: vi.fn(),
}));

// Captured addResult from the InterruptUI render so we can exercise the
// resume path without rendering the real AskLocationCard.
let capturedAddResult: ((payload: unknown) => void) | undefined;

vi.mock("@/components/tool-ui/toolkit", () => ({
  default: {
    ask_location: {
      render: ({
        message,
        addResult,
      }: {
        message?: string;
        addResult: (payload: unknown) => void;
      }) => {
        capturedAddResult = addResult;
        return <div data-testid="ask-location-stub">{message ?? "no-message"}</div>;
      },
    },
  },
}));

vi.mock("@/components/assistant-ui/working-indicator", () => ({
  WorkingIndicator: ({ text }: { text?: string }) => (
    <div data-testid="working-indicator">{text ?? "no-text"}</div>
  ),
}));

import { InterruptUI } from "@/components/assistant-ui/thread";
import { useLangGraphInterruptState, useLangGraphSendCommand } from "@assistant-ui/react-langgraph";

const mockInterrupt = vi.mocked(useLangGraphInterruptState);
const mockSendCommand = vi.mocked(useLangGraphSendCommand);
const sendCommand = vi.fn();
mockSendCommand.mockReturnValue(sendCommand);

beforeEach(() => {
  mockInterrupt.mockReset();
  sendCommand.mockReset();
  capturedAddResult = undefined;
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
});

describe("InterruptUI", () => {
  it("renders nothing when no interrupt is active", () => {
    mockInterrupt.mockReturnValue(undefined);
    const { container } = render(<InterruptUI />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when interrupt.value.ui has no matching renderer", () => {
    mockInterrupt.mockReturnValue({ value: { ui: "unknown_tool", data: {}, message: "hi" } });
    const { container } = render(<InterruptUI />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders WorkingIndicator with the interrupt message", () => {
    mockInterrupt.mockReturnValue({
      value: { ui: "ask_location", data: {}, message: "Pick one." },
    });
    vi.stubEnv("NEXT_PUBLIC_USE_SUBGRAPH", "false");
    render(<InterruptUI />);
    expect(screen.getByTestId("working-indicator")).toHaveTextContent("Pick one.");
  });

  it("does not mount the renderer when USE_SUBGRAPH is false (default)", () => {
    mockInterrupt.mockReturnValue({ value: { ui: "ask_location", data: {}, message: "Pick." } });
    vi.stubEnv("NEXT_PUBLIC_USE_SUBGRAPH", "false");
    render(<InterruptUI />);
    expect(screen.queryByTestId("ask-location-stub")).not.toBeInTheDocument();
  });

  it("mounts the matching renderer and forwards its addResult to sendCommand", () => {
    mockInterrupt.mockReturnValue({
      value: { ui: "ask_location", data: { foo: "bar" }, message: "Pick." },
    });
    vi.stubEnv("NEXT_PUBLIC_USE_SUBGRAPH", "true");
    render(<InterruptUI />);
    expect(screen.getByTestId("ask-location-stub")).toBeInTheDocument();

    capturedAddResult?.({ lat: 1, lon: 2, label: "x" });
    expect(sendCommand).toHaveBeenCalledWith({ resume: { lat: 1, lon: 2, label: "x" } });
  });

  it("treats NEXT_PUBLIC_USE_SUBGRAPH=1 the same as =true", () => {
    mockInterrupt.mockReturnValue({ value: { ui: "ask_location", data: {}, message: "Pick." } });
    vi.stubEnv("NEXT_PUBLIC_USE_SUBGRAPH", "1");
    render(<InterruptUI />);
    expect(screen.getByTestId("ask-location-stub")).toBeInTheDocument();
  });
});
