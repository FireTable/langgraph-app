// Crypto card e2e harness — mounts each of the 3 atomic cards in
// vertical sequence. The Playwright spec visits /, locates each card
// by its data-slot attribute, and verifies atomic behavior (one
// button per card, one resume payload per click).
//
// Wagmi + LangGraph + RainbowKit are aliased to lightweight stubs via
// vite.config.ts. The cards run unmodified.

import { createRoot } from "react-dom/client";

import {
  ConnectWalletCard,
  OrderStatusCard,
  PlaceCryptoOrderCard,
} from "@/components/tool-ui/crypto";

// Install the global sendCommand shim BEFORE rendering. The stubbed
// useLangGraphSendCommand hook (see stubs/langgraph.ts) reads this.
(
  globalThis as unknown as { __cryptoSendCommand?: (cmd: { resume: string }) => void }
).__cryptoSendCommand = (cmd: { resume: string }) => {
  let payload: unknown = cmd.resume;
  try {
    payload = JSON.parse(cmd.resume);
  } catch {
    /* keep raw */
  }
  const node = document.getElementById("last-payload");
  if (node) node.textContent = JSON.stringify(payload, null, 2);
  window.dispatchEvent(new CustomEvent("crypto:resume", { detail: payload }));
};

function App() {
  // The place-order card picks up the target from the URL so a spec can
  // target a specific coin (BTC, ETH, …) without rebuilding the harness.
  // The source is hardcoded to Mock Coin in the card. Format:
  // ?target=bitcoin&amount=100
  const params = new URLSearchParams(window.location.search);
  const placeArgs = {
    target_coin_id: params.get("target") ?? "ethereum",
    amount: params.get("amount") ? Number(params.get("amount")) : undefined,
  };
  // Crypto cards type their props against the real ToolCallMessagePart shape
  // (`type` / `toolCallId` / `toolName` / `args` / `argsText` / `status`),
  // which this harness can't satisfy without faking the runtime. We only care
  // about exercising the per-card click flow, so cast to `any` here — this
  // file is a test fixture, not production code.
  // ponytail: ComponentProps<X> is too strict (cards wrap forwardRef and add
  // optional DOM attrs we don't care about); `as any` is the right escape.
  const connectProps = { args: {}, result: undefined } as any;
  const placeProps = { args: placeArgs, result: undefined } as any;
  const orderProps = {
    args: { order_uid: "ord_test_abc123", chain_id: 8453 },
    result: undefined,
  } as any;
  return (
    <div>
      <section data-card="connect-wallet">
        <ConnectWalletCard {...connectProps} />
      </section>
      <section data-card="place-crypto-order">
        <PlaceCryptoOrderCard {...placeProps} />
      </section>
      <section data-card="order-status">
        <OrderStatusCard {...orderProps} />
      </section>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
