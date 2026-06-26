import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { mainnet } from "wagmi/chains";

vi.mock("@assistant-ui/react-langgraph", () => ({
  useLangGraphSendCommand: () => vi.fn(),
}));

vi.mock("wagmi/connectors", () => ({
  injected: () => ({ id: "injected", type: "injected" }),
}));

const mockUseAccount = vi.fn();

vi.mock("wagmi", async () => {
  const actual = await vi.importActual<typeof import("wagmi")>("wagmi");
  return {
    ...actual,
    useAccount: () => mockUseAccount(),
    useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false }),
    useBalance: () => ({ data: undefined }),
  };
});

import { AskCryptoIntentCard } from "@/components/tool-ui/crypto/ask-crypto-intent-card";

const config = createConfig({
  chains: [mainnet],
  transports: { [mainnet.id]: http() },
  ssr: true,
});

function renderCard(args: Record<string, unknown> = {}) {
  const qc = new QueryClient();
  // Card takes a ToolCallMessagePart prop; only args/result are exercised by these tests.
  const stub = {
    type: "tool-call",
    toolCallId: "test",
    toolName: "ask_crypto_intent",
    argsText: "",
    args,
    result: undefined,
  } as never;
  return render(
    <QueryClientProvider client={qc}>
      <WagmiProvider config={config}>
        <AskCryptoIntentCard {...stub} />
      </WagmiProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAccount.mockReturnValue({ address: undefined, isConnected: false });
});

afterEach(() => {
  cleanup();
});

describe("AskCryptoIntentCard amount input", () => {
  it("marks negative input invalid and disables the order button", () => {
    renderCard();
    const input = screen.getByPlaceholderText("100") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "-100" } });
    // The input keeps the literal text so the user can see what they
    // typed; Decimal rejects the value at validation time and the
    // button goes disabled instead of silently shipping a negative.
    expect(input.value).toBe("-100");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.className).toContain("border-destructive");
    const btn = screen.getByRole("button", { name: /connect.*buy/i });
    expect(btn).toBeDisabled();
  });

  it("keeps positive values unchanged and valid", () => {
    renderCard();
    const input = screen.getByPlaceholderText("100") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "250.5" } });
    expect(input.value).toBe("250.5");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    const btn = screen.getByRole("button", { name: /connect.*buy/i });
    expect(btn).not.toBeDisabled();
  });

  it("allows empty input", () => {
    renderCard();
    const input = screen.getByPlaceholderText("100") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    // Empty is not invalid — it's just not yet filled in.
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("rejects scientific notation (1e2) without breaking the input", () => {
    renderCard();
    const input = screen.getByPlaceholderText("100") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1e2" } });
    expect(input.value).toBe("1e2");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const btn = screen.getByRole("button", { name: /connect.*buy/i });
    expect(btn).toBeDisabled();
  });

  it("rejects non-numeric junk", () => {
    renderCard();
    const input = screen.getByPlaceholderText("100") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: /connect.*buy/i })).toBeDisabled();
  });

  it("rejects multiple decimal points", () => {
    renderCard();
    const input = screen.getByPlaceholderText("100") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1.2.3" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("AskCryptoIntentCard currency detection", () => {
  it("labels the amount input with the LLM-detected currency (CNY)", () => {
    renderCard({ currency: "CNY" });
    expect(screen.getByText(/amount \(cny\)/i)).toBeTruthy();
  });

  it("labels the amount input with the LLM-detected currency (EUR)", () => {
    renderCard({ currency: "EUR" });
    expect(screen.getByText(/amount \(eur\)/i)).toBeTruthy();
  });

  it("falls back to USD when no currency is passed", () => {
    renderCard();
    expect(screen.getByText(/amount \(usd\)/i)).toBeTruthy();
  });

  it("pre-fills the amount input from the LLM's hint", () => {
    renderCard({ currency: "CNY", amount: 250 });
    const input = screen.getByPlaceholderText("100") as HTMLInputElement;
    expect(input.value).toBe("250");
  });
});

describe("AskCryptoIntentCard wallet flow", () => {
  it("renders a 'Connect & buy' button when no wallet is connected", () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false });
    renderCard();
    expect(screen.getByRole("button", { name: /connect.*buy/i })).toBeTruthy();
  });

  it("renders a 'Confirm buy' button (no wallet prompt) when connected", () => {
    mockUseAccount.mockReturnValue({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      isConnected: true,
    });
    renderCard();
    expect(screen.getByRole("button", { name: /confirm.*buy/i })).toBeTruthy();
  });

  it("shows the connected address + a connect dialog trigger is hidden", () => {
    mockUseAccount.mockReturnValue({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      isConnected: true,
    });
    renderCard();
    expect(screen.getByText(/0x1234…5678/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect.*buy/i })).toBeNull();
  });
});
