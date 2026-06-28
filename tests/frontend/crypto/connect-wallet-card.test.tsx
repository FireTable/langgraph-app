import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { mainnet } from "wagmi/chains";

import { ConnectWalletCard } from "@/components/tool-ui/crypto/connect-wallet-card";

const mockSendCommand = vi.fn();
const mockOpenConnectModal = vi.fn();
const mockOpenAccountModal = vi.fn();
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
    useAccountModal: () => ({ openAccountModal: mockOpenAccountModal }),
  };
});

beforeEach(() => {
  mockSendCommand.mockReset();
  mockOpenConnectModal.mockReset();
  mockOpenAccountModal.mockReset();
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

describe("ConnectWalletCard — connected, awaiting confirmation", () => {
  beforeEach(() => {
    mockUseAccount.mockReturnValue({
      address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      isConnected: true,
      chainId: 8453,
    });
  });

  it("renders the connected address in the header", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    expect(screen.getByText(/0xAbCd…Ef01/)).toBeTruthy();
  });

  it("renders Cancel on the left and Use this wallet on the right", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    const cancel = screen.getByRole("button", { name: /^cancel$/i });
    const useThis = screen.getByRole("button", { name: /use this wallet/i });
    expect(cancel).toBeTruthy();
    expect(useThis).toBeTruthy();
    expect(cancel.compareDocumentPosition(useThis) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("clicking 'Use this wallet' sends resume with {address, chainId}", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /use this wallet/i }));
    expect(mockSendCommand).toHaveBeenCalledTimes(1);
    const arg = mockSendCommand.mock.calls[0]?.[0] as { resume: string };
    const payload = JSON.parse(arg.resume);
    expect(payload.address).toBe("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01");
    expect(payload.chainId).toBe(8453);
  });

  it("clicking Cancel sends resume with {error:'cancelled'}", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(mockSendCommand).toHaveBeenCalledTimes(1);
    const arg = mockSendCommand.mock.calls[0]?.[0] as { resume: string };
    expect(JSON.parse(arg.resume)).toEqual({ error: "cancelled" });
  });

  it("chevron trigger opens a menu with 'Use a different wallet'", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more options/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /use a different wallet/i }));
    expect(mockOpenAccountModal).toHaveBeenCalledTimes(1);
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  it("does not auto-resume on mount", () => {
    wrap(<ConnectWalletCard {...makeProps(undefined)} />);
    expect(mockSendCommand).not.toHaveBeenCalled();
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
