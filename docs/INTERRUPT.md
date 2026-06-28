# Interrupts — pausing the graph for human input

LangGraph's `interrupt()` halts the current run and surfaces a payload to the
runtime. The frontend reads that payload, renders UI, and resumes the run by
sending back a value. This doc covers the contract from both sides — server
(caller) and frontend (consumer) — and the topology split that currently
gives interrupts two runtime paths.

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

`InterruptUI` reads `useLangGraphInterruptState()` and dispatches on
`interrupt.value.ui`. The `toolkit` registry (`components/tool-ui/toolkit.tsx`)
maps `ui` → React renderer. The renderer's `addResult` (or its own
`useLangGraphSendCommand` hook) is the resume path:

```tsx
<Render
  args={{ ...interrupt.value.data }}
  result={undefined}
  addResult={(payload) => sendCommand({ resume: payload })}
/>
```

Only one interrupt can be active per thread. `InterruptUI` is mounted inside
the **last** assistant message (`isLast` gate) so it doesn't render once per
older message.

### Resume shape

Whatever the frontend sends via `sendCommand({ resume })` is what
`interrupt()` returns on the next pass. Pick a stable JSON shape and document
it on both sides. Keep payload small — it's serialized into the SSE stream.

## Runtime paths — depends on `USE_SUBGRAPH`

Subgraph mode preserves `interrupt()` semantics. Inlined mode routes the
pause through the `ToolNode`'s `ToolMessage` channel — the user-facing flow is
the same (UI mounts, user picks, run resumes) but the mechanism under the
hood differs:

| Mode                               | Pause mechanism                                                                      | Card mount                                                             | Resume mechanism                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| **`USE_SUBGRAPH=true`**            | `interrupt()` is honored across the parent ↔ subgraph boundary                       | `InterruptUI` in `thread.tsx` (driven by `useLangGraphInterruptState`) | `sendCommand({ resume })` from the card                   |
| **`USE_SUBGRAPH=false`** (default) | `interrupt()` is caught by the inlined flow and surfaced as a `ToolMessage` sentinel | Tool-call slot in the message part list                                | `addResult(payload)` overwrites the `ToolMessage` content |

The card itself is the same React component in both paths; only where it
mounts and how it resumes change. In inlined mode the card uses the
`addResult` prop; in subgraph mode it defines its own resume via
`useLangGraphSendCommand` (the `addResult` prop never carries a useful
value).

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
4. **Card.** Mount via the toolkit renderer. Use the `addResult` prop in inlined mode, or `useLangGraphSendCommand` in subgraph mode (the same card supports both — see `ask-location-card.tsx`).
5. **Prompt.** Tell the model to call the tool exactly once per turn and not to batch it with other tool calls (the human input races any parallel tool result).
6. **Docs.** Update this file with the new tool's `ui` name and payload shape.

## Debugging

- **Card never mounts (subgraph mode).** Check `NEXT_PUBLIC_USE_SUBGRAPH` is
  set in `.env.local`. Restart `pnpm dev:frontend` after changing
  `NEXT_PUBLIC_*` vars — Next.js inlines them at build time.
- **Card never mounts (inlined mode).** The model didn't emit the tool's
  `tool_call` (check the LLM trace), or the card's render path isn't keyed
  on the `ToolMessage` content.
- **Multiple cards stacked.** The model emitted the same `tool_call` more
  than once in a turn. Tighten the prompt or filter duplicates in the card.
- **Resume does nothing.** Verify the frontend payload matches the
  tool's expected shape. In inlined mode, `addResult` requires the
  `ToolMessage` to already exist — if the card is in the wrong slot, it
  has nothing to overwrite.

## Why two paths exist

LangGraph JS subgraphs trigger the "Run ID not found in run map" bug under
`@langchain/core@1.2.1`. The inlined topology is the workaround — it removes
the subgraph boundary, so `interrupt()` never crosses into a child run. The
downside is duplicated model/tool code (the inlined nodes mirror
`backend/agent/weather-agent.ts` + `chat-agent.ts`). When core ships a fix,
flip the default and delete the inlined builder — see
`memory/langgraph-subgraph-run-map-bug.md`.
