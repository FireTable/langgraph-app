# Interrupts — pausing the graph for human input

LangGraph's `interrupt()` halts the current run and surfaces a payload to the
runtime. The frontend reads that payload, renders UI, and resumes the run by
sending back a value. This doc covers the contract from both sides — server
(caller) and frontend (consumer).

## Contract

### Server side — `backend/tool/*.ts`

A tool calls `interrupt(value)` inside its `invoke` body. The runtime treats
the call as a graph-level pause:

```ts
import { interrupt } from "@langchain/langgraph";

async () => {
  const pick = interrupt({ ui: "ask_location", data: {}, message: "..." });
  return pick;
};
```

On resume, `interrupt()` returns whatever the frontend sent back. Treat the
returned value as untrusted (validate it).

### Frontend side — `components/assistant-ui/thread.tsx`

The `toolkit` registry (`components/tool-ui/toolkit.tsx`) maps each tool's
`ui` discriminator to a React card. The card is mounted by the toolkit's
`render` in the tool-call slot of the matching `ToolMessage`. The card itself
owns the resume path — it calls `useLangGraphSendCommand` directly with
`{ resume: payload }`:

```tsx
const sendCommand = useLangGraphSendCommand();
sendCommand({ resume: JSON.stringify(payload) });
```

Only one interrupt can be active per thread (the active subgraph's task
holds the slot until the resume lands).

### Resume shape

Whatever the frontend sends via `sendCommand({ resume })` is what
`interrupt()` returns on the next pass. Pick a stable JSON shape and document
it on both sides. Keep payload small — it's serialized into the SSE stream.

## Resume mechanism

Each picker card uses `useLangGraphSendCommand` directly and ships a
`{ resume }` payload shaped to the matching tool. The parent graph routes the
resume via the subgraph that originally raised the interrupt — namespace
matching is server-side (`__pregel_resume_map[ns]`), so the card doesn't need
to know which sub-agent paused.

## Examples

Four interrupts are currently in use: one for the weather flow, three for the
crypto trade flow. The contract (`{ ui, data, message }`) is the same — only
the `ui` discriminator and resume payload differ.

### `ask_location` — weather flow

Tool (`backend/tool/ask-location.ts`):

```ts
export const ASK_LOCATION_TOOL_NAME = "ask_location";

export const askLocationTool = tool(
  async ({ message }) => interrupt({ ui: ASK_LOCATION_TOOL_NAME, data: {}, message }),
  {
    name: ASK_LOCATION_TOOL_NAME,
    schema: z.object({ message: z.string() }),
  },
);
```

Card (`components/tool-ui/ask-location/ask-location-card.tsx`) renders a
geolocation button + city input. Payload:

```ts
type AskLocationResult =
  | { lat: number; lon: number; label: string } // picked coords
  | { error: string }; // permission denied / geocode failed
```

### `connect_wallet` — crypto trade flow, step 1

Tool (`backend/tool/crypto/connect-wallet.ts`) opens RainbowKit on resume.
The card reads the address + chain from wagmi state and forwards them back
as the resume value:

```ts
type ConnectWalletResume =
  | { address: `0x${string}`; chainId: number } // user picked a wallet
  | { cancelled: true; message?: string }; // user dismissed the modal
```

### `place_crypto_order` — crypto trade flow, step 2

Tool (`backend/tool/crypto/place-crypto-order.ts`) fetches a live CoinGecko
USD quote against Mock Coin and synthesizes a `SimulatedOrder` on click.
Payload:

```ts
type PlaceCryptoOrderResume =
  | SimulatedOrder // status: "simulated_filled", has order_uid + amounts
  | { status: "cancelled"; message?: string };
```

### `get_order_status` — crypto trade flow, step 3

Tool (`backend/tool/crypto/get-order-status.ts`) is a pure trigger; the
synthetic `order_uid` returned by `place_crypto_order` isn't a real
on-chain order, so the card synthesizes a status on click. Payload:

```ts
type GetOrderStatusResume =
  | { status: "open" | "filled" | "cancelled" | "expired" | "partially_filled" /* … */ }
  | { status: "error"; message: string };
```

### `write_code` — code agent, step 1

Tool (`backend/tool/code/index.ts`) shows the user a code editor with
a Run button. The user can edit, then click Run. The tool returns the
resume payload to the LLM, which then calls `execute_code` with the
code from the run payload. `execute_code` is only registered when
`DENO_DEPLOY_TOKEN` + `DENO_DEPLOY_SANDBOX_URL` are both set — when
they aren't, the model surfaces a graceful fallback (inline compute
or "I can't execute right now") after a Run. Payload:

```ts
type WriteCodeResume =
  | { action: "run"; code: string } // user clicked Run, possibly after editing
  | { action: "cancel" }; // user dismissed the editor
```

## Adding a new interrupt-driven tool

1. **Server.** Add a tool under `backend/tool/`. Call `interrupt({ ui, data, message })` and validate the resumed value before using it. Keep the `ui` string stable — it becomes the toolkit registry key.
2. **Payload.** Pick a JSON shape. Define a `Result` type on the frontend card so the two sides stay in sync.
3. **Toolkit registry.** Add an entry in `components/tool-ui/toolkit.tsx` keyed by `ui`. Reuse an existing card or write a new one.
4. **Card.** Mount via the toolkit renderer. Use `useLangGraphSendCommand` to send the `{ resume }` payload — see `ask-location-card.tsx` for the canonical shape.
5. **Prompt.** Tell the model to call the tool exactly once per turn and not to batch it with other tool calls (the human input races any parallel tool result).
6. **Docs.** Update this file with the new tool's `ui` name and payload shape.

## Debugging

- **Card never mounts.** The model didn't emit the tool's `tool_call` (check
  the LLM trace), or the card's render path isn't keyed on the `ToolMessage`
  content. If the model emitted `tool_calls` but no card shows up,
  `streamSubgraphs: true` may be missing from `lib/langgraph/create-stream.ts`
  — required for namespaced `__interrupt__` events to surface in the browser.
- **Multiple cards stacked.** The model emitted the same `tool_call` more
  than once in a turn. Tighten the prompt or filter duplicates in the card.
- **Resume does nothing.** Verify the frontend payload matches the tool's
  expected JSON shape, and that the card calls `useLangGraphSendCommand` with
  `{ resume: payload }` (not with `addResult`, which only overwrites the
  visible `ToolMessage`).
