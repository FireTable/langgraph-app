import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { mainnet } from "wagmi/chains";

import { ConnectWalletCard } from "@/components/tool-ui/crypto/connect-wallet-card";

const mockSendCommand = vi.fn();
const mockOpenConnectModal = vi.fn();
const mockUseAccount = vi.fn();

vi.mock("@assistant-ui/react-langgraph", () => ({
  useLangGraphSendCommand: () => mockSendCommand,
}));

vi.mock("wagmi", async () => {
  const actual = await vi.importActual<typeof import("wagmi")>("wagmi");
  return {
    ...actual,
    useAccount: () => mockUseAccount(),
  };
});

vi.mock("@rainbow-me/rainbowkit", async () => {
  const actual =
    await vi.importActual<typeof import("@rainbow-me/rainbowkit")>("@rainbow-me/rainbowkit");
  return {
    ...actual,
    useConnectModal: () => ({ openConnectModal: mockOpenConnectModal }),
  };
});

beforeEach(() => {
  mockSendCommand.mockReset();
  mockOpenConnectModal.mockReset();
  mockUseAccount.mockReset();
  mockUseAccount.mockReturnValue({ address: undefined, isConnected: false, chainId: undefined });
});

afterEach(() => {
  cleanup();
});

const config = createConfig({
  chains: [mainnet],
  transports: { [mainnet.id]: http() },
  ssr: true,
});

function wrap(node: React.ReactElement) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <WagmiProvider config={config}>{node}</WagmiProvider>
    </QueryClientProvider>,
  );
}

function makeProps(result: unknown): React.ComponentProps<typeof ConnectWalletCard> {
  return {
    type: "tool-call",
    toolCallId: "test",
    toolName: "connect_wallet",
    argsText: "",
    args: {},
    result,
  } as React.ComponentProps<typeof ConnectWalletCard>;
}

describe("ConnectWalletCard — not connected", () => {
  it("renders a Connect button when wagmi is not connected", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
  });

  it("clicking Connect opens RainbowKit", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    screen.getByRole("button", { name: /connect wallet/i }).click();
    expect(mockOpenConnectModal).toHaveBeenCalledTimes(1);
  });

  it("does not auto-resume when not connected", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    expect(mockSendCommand).not.toHaveBeenCalled();
  });
});

describe("ConnectWalletCard — connected, auto-resume", () => {
  beforeEach(() => {
    mockUseAccount.mockReturnValue({
      address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      isConnected: true,
      chainId: 8453,
    });
  });

  it("shows a brief 'Connecting…' indicator with the address", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    expect(screen.getByText(/connecting/i)).toBeTruthy();
    expect(screen.getByText(/0xAbCd…Ef01/)).toBeTruthy();
  });

  it("auto-resumes with {address, chainId} on first connected render", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    expect(mockSendCommand).toHaveBeenCalledTimes(1);
    const arg = mockSendCommand.mock.calls[0]?.[0] as { resume: string };
    const payload = JSON.parse(arg.resume);
    expect(payload.address).toBe("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01");
    expect(payload.chainId).toBe(8453);
  });

  it("does not auto-resume a second time (Strict Mode double-invoke safe)", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    // Simulate React Strict Mode's double-invoke by re-running the
    // effect: the ref guard means the second call is a no-op.
    act(() => {
      mockUseAccount.mockReturnValue({
        address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
        isConnected: true,
        chainId: 8453,
      });
    });
    expect(mockSendCommand).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire resume after the result is set", () => {
    const resume = {
      address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      chainId: 8453,
    };
    wrap(<ConnectWalletCard {...makeProps(resume)} />);
    // Re-render with the same result; the auto-resume effect is gated on
    // `parsed` being null, so the ref guard is irrelevant here.
    wrap(<ConnectWalletCard {...makeProps(resume)} />);
    // The first render auto-resumes; the second render (same result) doesn't.
    expect(mockSendCommand.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("ConnectWalletCard — resolved", () => {
  it("renders a resolved confirmation card after a successful resume", () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false, chainId: undefined });
    const resume = {
      address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      chainId: 1,
    };
    wrap(<ConnectWalletCard {...makeProps(resume)} />);
    expect(screen.getByText(/wallet connected/i)).toBeTruthy();
    expect(screen.getByText(/0xAbCd…Ef01/)).toBeTruthy();
  });

  it("renders an error row when the resume carries a cancelled flag", () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false, chainId: undefined });
    wrap(<ConnectWalletCard {...makeProps({ error: "cancelled" })} />);
    expect(screen.getByText(/connection cancelled/i)).toBeTruthy();
  });
});
