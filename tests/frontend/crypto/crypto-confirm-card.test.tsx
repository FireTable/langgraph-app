import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { mainnet } from "wagmi/chains";

import { CryptoConfirmCard } from "@/components/tool-ui/crypto/confirm-card";

// --- Mocks -----------------------------------------------------------------

vi.mock("@assistant-ui/react-langgraph", () => ({
  useLangGraphSendCommand: () => mockSendCommand,
}));

vi.mock("wagmi", async () => {
  const actual = await vi.importActual<typeof import("wagmi")>("wagmi");
  return {
    ...actual,
    useAccount: () => mockUseAccount(),
    useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
    useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
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

const mockSendCommand = vi.fn();
const mockOpenConnectModal = vi.fn();
const mockUseAccount = vi.fn();
const mockSignTypedDataAsync = vi.fn();

// Portfolio API mock — a single call returns balance + metadata + price
// for every token the wallet holds across all 3 CoW chains. USDC is the
// user's biggest holding; WETH + native ETH are peers so the card's
// native-token row + USD-value column rendering is exercised.
const PORTFOLIO_RESPONSE = {
  data: {
    tokens: [
      {
        network: "eth-mainnet",
        tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC mainnet
        tokenBalance: "0x5f5e100", // 100 USDC (6 decimals)
        tokenMetadata: {
          symbol: "USDC",
          decimals: 6,
          name: "USD Coin",
          logo: "https://example.com/usdc.png",
        },
        tokenPrices: [{ currency: "usd", value: "1.0" }],
      },
      {
        network: "eth-mainnet",
        tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH mainnet
        tokenBalance: "0x16345785d8a0000", // 0.1 WETH (18 decimals)
        tokenMetadata: {
          symbol: "WETH",
          decimals: 18,
          name: "Wrapped Ether",
          logo: "https://example.com/weth.png",
        },
        tokenPrices: [{ currency: "usd", value: "3100.0" }],
      },
      {
        network: "eth-mainnet",
        tokenAddress: null, // native ETH
        tokenBalance: "0x16345785d8a0000", // 0.1 ETH
        tokenMetadata: {
          symbol: "ETH",
          decimals: 18,
          name: "Ether",
          logo: "https://example.com/eth.png",
        },
        tokenPrices: [{ currency: "usd", value: "3100.0" }],
      },
    ],
  },
};

function mockFetchImpl(input: RequestInfo | URL, _init?: RequestInit) {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/alchemy/portfolio/tokens/by-address")) {
    return Promise.resolve(
      new Response(JSON.stringify(PORTFOLIO_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  // CoW quote
  if (url.includes("/quote")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          sellToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          buyToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          sellAmount: "99988648",
          buyAmount: "41581080662656000",
          validTo: 1782539294,
          feeAmount: "11352",
          kind: "sell",
          partiallyFillable: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(mockFetchImpl));
  vi.clearAllMocks();
  mockUseAccount.mockReturnValue({ address: undefined, isConnected: false });
  mockSignTypedDataAsync.mockResolvedValue("0xsignature");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --- Test helpers ----------------------------------------------------------

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

type Result = Parameters<typeof CryptoConfirmCard>[0]["result"];

function makeProps(args: Record<string, unknown>, result: Result) {
  return {
    type: "tool-call" as const,
    toolCallId: "test",
    toolName: "confirm_crypto_order",
    argsText: "",
    args,
    result,
    status: { type: "complete" as const },
  };
}

function intentArgs(overrides: Record<string, unknown> = {}) {
  return {
    side: "sell",
    source_coin_id: "usd-coin",
    ...overrides,
  };
}

function awaitingResult(intent: Record<string, unknown> = {}) {
  return {
    status: "awaiting_user" as const,
    intent: {
      side: "sell" as const,
      source_coin_id: "usd-coin",
      amount: null,
      target_coin_id: null,
      ...intent,
    },
  };
}

// --- Tests -----------------------------------------------------------------

describe("CryptoConfirmCard — wallet gate", () => {
  it("renders a Connect wallet button when no wallet is connected", async () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false });
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(mockOpenConnectModal).toHaveBeenCalledTimes(1);
  });

  it("renders an unsupported-chain error when wagmi is on Polygon etc.", async () => {
    mockUseAccount.mockReturnValue({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      isConnected: true,
      chainId: 137,
    });
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    expect(screen.getByText(/isn't supported/i)).toBeTruthy();
  });
});

describe("CryptoConfirmCard — connected wallet", () => {
  beforeEach(() => {
    mockUseAccount.mockReturnValue({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      isConnected: true,
      chainId: 1,
    });
  });

  it("lists the user's balances and pre-selects the LLM-hinted source", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => {
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/WETH/).length).toBeGreaterThan(0);
    // USDC button (the LLM hinted "usd-coin") should be in the primary
    // (selected) style — we assert via data-action + class scan rather
    // than the rendered text since multiple elements contain "USDC".
    const selected = screen
      .getAllByRole("button")
      .find(
        (b) => b.getAttribute("data-action") === "select-source" && b.textContent?.includes("USDC"),
      );
    expect(selected?.className).toContain("bg-primary/10");
  });

  it("renders a single Portfolio fetch (no per-chain JSON-RPC for balances)", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => {
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0);
    });
    const fetchCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    const portfolioCalls = fetchCalls.filter(([u]) =>
      String(u).includes("/api/alchemy/portfolio/tokens/by-address"),
    );
    const legacyRpcCalls = fetchCalls.filter(([u]) =>
      String(u).match(/\/api\/alchemy\/(eth|arb|base)-mainnet/),
    );
    expect(portfolioCalls.length).toBe(1);
    expect(legacyRpcCalls.length).toBe(0);
  });

  it("renders the native ETH row with the (native) marker", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => {
      expect(screen.getAllByText(/native/).length).toBeGreaterThan(0);
    });
    // Native ETH button is the one whose row contains "(native)" — WETH
    // is also "ETH"-shaped but is the wrapped ERC20 (no marker).
    const nativeBtn = screen
      .getAllByRole("button")
      .find(
        (b) =>
          b.getAttribute("data-action") === "select-source" &&
          /\(native\)/i.test(b.textContent ?? ""),
      );
    expect(nativeBtn).toBeTruthy();
    expect(nativeBtn?.textContent).toMatch(/ETH/);
  });

  it("renders the USD-value column for each row", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => {
      // 100 USDC @ $1 = $100, 0.1 WETH @ $3100 = $310, 0.1 ETH @ $3100 = $310
      expect(screen.getAllByText(/≈ \$100/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/≈ \$310/).length).toBeGreaterThan(1);
  });

  it("sorts native to the top of each chain group, then by USD value desc", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => {
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0);
    });
    const selectButtons = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-action") === "select-source");
    // First chain group is Ethereum; mock data is native ETH (~$310),
    // WETH (~$310), USDC (~$100). Native always wins, then USD desc —
    // so the visible order is ETH (native), WETH, USDC.
    const symbolOrder = selectButtons
      .map((b) => b.textContent ?? "")
      .filter((t) => /(USDC|WETH|ETH)/.test(t));
    expect(symbolOrder.length).toBeGreaterThanOrEqual(3);
    // Native ETH row is the first one — it carries the "(native)" marker.
    expect(symbolOrder[0]).toMatch(/\(native\)/i);
    expect(symbolOrder[0]).toMatch(/ETH/);
    // USDC (lowest USD in this group) is still last.
    const usdcIdx = symbolOrder.findIndex((t) => t.includes("USDC"));
    expect(usdcIdx).toBeGreaterThanOrEqual(2);
  });

  it("renders the token logo image for each row", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => {
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0);
    });
    // Logos are decorative (alt="") so jsdom drops the img role; query
    // the DOM directly. We assert the USDC src made it through to the
    // DOM without needing to count all 3 logos.
    const imgs = document.querySelectorAll("img");
    expect(imgs.length).toBeGreaterThan(0);
    expect(
      Array.from(imgs).some((img) => img.getAttribute("src") === "https://example.com/usdc.png"),
    ).toBe(true);
  });

  it("renders the Alchemy chain emblem next to each chain group header", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => {
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0);
    });
    // The mock balances all live on Ethereum, so the chain group header
    // should carry the eth-mainnet.svg emblem from the catalog.
    const groupHeader = document.querySelector(
      'img[src="https://static.alchemyapi.io/images/emblems/eth-mainnet.svg"]',
    );
    expect(groupHeader).toBeTruthy();
    // Emblem is decorative — the surrounding label carries the name.
    expect(groupHeader?.getAttribute("alt")).toBe("");
  });

  it("pre-selects the LLM-hinted target and falls back to WETH when source is a stablecoin", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => {
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("weth");
    });
  });

  it("honors the LLM's target_coin_id hint", async () => {
    wrap(
      <CryptoConfirmCard
        {...(makeProps(
          intentArgs(),
          awaitingResult({ target_coin_id: "wrapped-bitcoin" }),
        ) as never)}
      />,
    );
    await waitFor(() => {
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("wbtc");
    });
  });

  it("calls CoW /quote once source/amount/target are valid", async () => {
    wrap(
      <CryptoConfirmCard {...makeProps(intentArgs(), awaitingResult({ amount: 100 }) as never)} />,
    );
    await waitFor(() => {
      const fetchCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(fetchCalls.some(([u]) => String(u).includes("/quote"))).toBe(true);
    });
  });

  it("disables the Sign button until a quote loads", async () => {
    wrap(
      <CryptoConfirmCard
        {...(makeProps(intentArgs(), awaitingResult({ amount: 100 })) as never)}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/you receive/i)).toBeTruthy();
    });
    // Quote effect debounces 400ms; wait for Sign to enable.
    const signBtn = await screen.findByRole("button", { name: /confirm sell/i });
    await waitFor(() => {
      expect((signBtn as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("shows a 'Confirm order' header in both buy and sell mode", async () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), awaitingResult()) as never)} />);
    await waitFor(() => expect(screen.getByText(/^Confirm order$/)).toBeTruthy());
    wrap(
      <CryptoConfirmCard
        {...(makeProps(
          intentArgs({ side: "buy" }),
          awaitingResult({ side: "buy" as const }),
        ) as never)}
      />,
    );
    await waitFor(() => expect(screen.getAllByText(/^Confirm order$/).length).toBeGreaterThan(0));
  });

  it("clicking Confirm calls addResult with simulated_filled + the quote-derived qty", async () => {
    wrap(
      <CryptoConfirmCard
        {...(makeProps(intentArgs(), awaitingResult({ amount: 100 })) as never)}
      />,
    );
    const btn = await screen.findByRole("button", { name: /confirm sell/i });
    // Quote effect debounces 400ms; the click is a no-op until quote
    // loads. waitFor the button to enable before firing.
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(btn);
    expect(mockSendCommand).toHaveBeenCalledTimes(1);
    const arg = mockSendCommand.mock.calls[0][0];
    const payload = JSON.parse(arg.resume);
    expect(payload.status).toBe("simulated_filled");
    expect(payload.order.symbol).toBe("USDC");
    expect(payload.order.amount_human).toBe(100);
    expect(payload.order.qty).toBeCloseTo(0.041581, 5);
  });

  it("clicking Cancel calls addResult with cancelled", async () => {
    wrap(
      <CryptoConfirmCard
        {...(makeProps(intentArgs(), awaitingResult({ amount: 100 })) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    const arg = mockSendCommand.mock.calls[0][0];
    const payload = JSON.parse(arg.resume);
    expect(payload.status).toBe("cancelled");
  });
});

describe("CryptoConfirmCard — terminal states", () => {
  it("renders the SIMULATED receipt", () => {
    wrap(
      <CryptoConfirmCard
        {...(makeProps(intentArgs(), {
          status: "simulated_filled",
          order: {
            id: "ord_abc",
            coin: "usd-coin",
            symbol: "USDC",
            side: "sell",
            amount_human: 100,
            qty: 0.041581,
            status: "simulated_filled",
            timestamp: "2026-06-26T11:11:46Z",
            note: "Simulated fill.",
            slippage_bps: 50,
          },
        }) as never)}
      />,
    );
    expect(screen.getByText(/ord_abc/)).toBeTruthy();
    expect(screen.getByText("SIMULATED")).toBeTruthy();
  });

  it("renders the SIGNED receipt with the CoW order link", () => {
    const FAKE_UID = "0x" + "a".repeat(106) + "deadbeef";
    wrap(
      <CryptoConfirmCard
        {...(makeProps(intentArgs(), {
          status: "signed",
          chain_id: 1,
          order_uid: FAKE_UID,
        }) as never)}
      />,
    );
    expect(screen.getByText(/aaaaaaaa…adbeef/i)).toBeTruthy();
    expect(screen.getByText(/signed/i)).toBeTruthy();
  });

  it("renders a cancelled banner", () => {
    wrap(<CryptoConfirmCard {...(makeProps(intentArgs(), { status: "cancelled" }) as never)} />);
    expect(screen.getByText(/cancelled/i)).toBeTruthy();
  });

  it("renders an error banner", () => {
    wrap(
      <CryptoConfirmCard
        {...(makeProps(intentArgs(), { status: "error", error: "wallet rejected" }) as never)}
      />,
    );
    expect(screen.getByText(/wallet rejected/i)).toBeTruthy();
  });
});

describe("CryptoConfirmCard — malformed awaiting_user (defensive)", () => {
  it("surfaces a structured error when intent is missing", () => {
    wrap(
      <CryptoConfirmCard
        {...(makeProps(intentArgs(), { status: "awaiting_user" } as never) as never)}
      />,
    );
    expect(screen.getByText(/intent was missing/i)).toBeTruthy();
  });

  it("surfaces a structured error when intent.side is missing", () => {
    wrap(
      <CryptoConfirmCard
        {...(makeProps(intentArgs(), {
          status: "awaiting_user",
          intent: { source_coin_id: "usd-coin" },
        } as never) as never)}
      />,
    );
    expect(screen.getByText(/intent was missing/i)).toBeTruthy();
  });
});
