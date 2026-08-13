# Canvas (Design)

The app is chat-first; when the user expands the canvas, the layout flips to **full-canvas mode** — the React Flow (`@xyflow/react`) editor fills the entire main area, and the existing assistant-ui `<Thread>` floats on top as a translucent card (backdrop-blurred, ~360–400 px wide, anchored to the right edge). This file is the **design doc** — layout, data model, auto-save cadence, the image-generation tool. For HTTP endpoints see [`docs/APIS.md`](./APIS.md) § Canvas.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Header: [Sidebar] [ThreadTitle]              [Canvas toggle]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                                                             │
│             React Flow (CanvasEditor)                       │
│             fills the full main area                        │
│                                                             │
│       ┌──────────────────────────┐                          │
│       │ <Thread />    [collapse] │  ← translucent card,     │
│       │                          │    bottom-left collapse  │
│       └──────────────────────────┘                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Collapsed: card hides; a chat-bubble button appears at the
viewport's bottom-right (click it to reopen the chat).
```

- Toggle lives in the header (`components/chat/CanvasToggleButton.tsx`) — pushed to the far right with `ml-auto`, uses `LayoutPanelLeft` glyph to mirror the sidebar `PanelLeftIcon`. Hidden `< 768px` (mobile stays chat-only, per the user's tapNow-style decision). Header keeps `<ThreadTitle>` at all times — the sidebar's `<ThreadList>` is the canonical thread switcher, the inline header dropdown was redundant once canvas took the full area.
- **Canvas is user-toggled only — no auto-open.** The canvas opens when (and only when) the user clicks the toggle. There is no first-message auto-open, no first-thread heuristic, no rule that flips it on without an explicit click. Per-thread open/closed state is persisted in `localStorage` under `canvas:<threadId>:open` so the user's last choice is restored on refresh / thread-switch (`lib/canvas/prefs.ts`).
- The `<Thread>` is mounted _inside_ the canvas overlay (`CanvasSplitLayout`) — toggling off the canvas teardown unmounts the editor (and its React Flow listeners) and switches to plain `<Thread />`. `key={threadId}` on `CanvasEditor` forces a remount per thread so xyflow's internal store doesn't leak nodes across threads.
- Collapse control lives INSIDE the chat card at its bottom-left (`PanelRightCloseIcon`, `size-5`); collapsed → chat-bubble button at the viewport's bottom-right (`MessageCircleIcon`, `size-10`). Both transitions are CSS-driven (`transition-all duration-200 ease-out`) on `translate-x`/`opacity`/`scale` — no `tw-animate-css` keyframes (they don't pin final state when the element stays mounted).
- The React Flow editor uses three custom node types — `text`, `generate`, `preview` — registered in `nodeTypes`. Edges flow top→bottom; `Background` (dots) + `Controls` (zoom/pan) + `MiniMap` round out the chrome. No multi-page, no theme switching — one thread = one canvas.
- **No license key.** React Flow is MIT-licensed and ships without runtime gating. The previous tldraw integration needed `TLDRAW_LICENSE_KEY`; the switch dropped that requirement entirely.

## Data model

One table: `canvas_snapshots`. One row per thread.

```ts
{
  threadId: string; // PK + FK → threads.id (ON DELETE CASCADE)
  document: Record<string, unknown>; // React Flow { nodes, edges } blob (jsonb)
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

- `document` is the live React Flow state — `{ nodes: Node[], edges: Edge[] }` from `useReactFlow().getNodes()` / `getEdges()`. We don't store viewport/camera state — that's per-browser in xyflow's localStorage, not part of the snapshot.
- Cascade on thread delete: archiving a thread from the sidebar wipes its canvas row automatically (the FK does the work; no parallel canvas query).
- We deliberately don't re-validate the `document` server-side — React Flow's loader IS the validator. Round-tripping through zod would duplicate validation that drifts when xyflow evolves (every minor version adds / removes node props). The route only checks "non-null object" — anything malformed gets caught when the _next_ client calls `setNodes` / `setEdges`.

## Auto-save

`lib/canvas/auto-save.ts` — debounced PUT with beforeunload flush.

- **Debounce 2s** (`DEBOUNCE_MS = 2000`). Every change event from `getDocumentAction` resets the timer, so a continuous drag fires ONE save 2s after the user stops moving — not 100s while they drag.
- **last-write-wins**. A ref holds the latest document; on every change we overwrite it. The next flush sends the freshest payload.
- **beforeunload + pagehide** flush via `navigator.sendBeacon`. JSON blob, same endpoint. `sendBeacon` returns false when the browser refuses (> 64KB) — we fall back to `fetch(... keepalive: true)` so nothing is silently dropped.
- **Status state machine**: `idle → pending → saving → saved | error`. UI badge reads from `status`. 401/404 on save drops the pending payload (thread vanished or session expired — no point retrying).

## Image generation tool

`backend/tool/image/generate-image.ts` — `generate_image` LangGraph tool, registered in `CHAT_TOOLS`. Unconditional registration: the Pollinations backend is free (no key) and the fal.ai backend is opt-in via `FAL_KEY`. `lib/image/` exposes a per-platform factory (`createPollinationsBackend()` / `createFalBackend(apiKey)`) sharing a single `ImageBackend` interface; `pickImageBackend()` selects at call time.

- **Default (no `FAL_KEY`)**: GETs `https://image.pollinations.ai/prompt/<encoded>?width=W&height=H&seed=S&nologo=true&model=gptimage` and returns the URL. `gptimage` is pinned because it accepts the `image=` query param for image-to-image; the unnamed default flux silently drops it.
- **With `FAL_KEY`**: POSTs JSON to `https://fal.run/fal-ai/flux/schnell` with `{ prompt, aspect_ratio, num_images, image_url? }` and parses `{ images: [{ url }] }`. Supports image-to-image via the `image_url` body key.
- Both backends accept `image_url` for image-to-image. The chat model copies the URL from upstream canvas Image attachments into the tool call; the canvas card does the wiring via the `useCanvas()` bridge.
- Charges go through the existing credit system using the `kind: "pic"` model kind (`lib/credit/zod.ts modelKindSchema` + `lib/provider/schema.ts ModelKind`). Admins tag image-gen providers with `kind: ["pic"]` so the per-kind rate config routes correctly. Pollinations is free so no charges fire on the default path; fal.ai does, gated by `FAL_KEY`.

The tool result is rendered by `components/tool-ui/image/generate-image-card.tsx` (registered in `toolkit.tsx`). The card uses `useCanvas()` from `lib/canvas/context.tsx` to bridge into the live React Flow editor — see [Cross-component wiring](#cross-component-wiring).

## Cross-component wiring

The right-hand `<Thread>` panel and the left-hand React Flow editor live in different component trees. A tiny context (`lib/canvas/context.tsx`) bridges them:

- `CanvasProvider` lives in `CanvasSplitLayout` and exposes two contexts: `useCanvas()` (read access for tool-ui cards) and `useCanvasRegister()` (the mount-time setter for `CanvasEditor`).
- `CanvasEditor` calls `register({ rf, getSourceNode, insertImage, focusNode, addEdge })` in `onInit` and `register(null)` on unmount. Tool cards read `useCanvas()` → `{ ready, insertImage({ url, w?, h? }), focusNode(id), addEdge({source, target, system}) }`.
- When the canvas is closed, `useCanvas()` returns the no-op default (`ready: false, …`). The image card renders the button as disabled with the label "Open canvas to add".
- Default size is 256×256 (canvas Preview node dims). The card scales to 192×256 (portrait) or 256×192 (landscape) when `aspect_ratio` is set, dropping the node at the source's position +40px Y, +20px per variant so they don't overlap.

## Component map

| File                                               | Role                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/canvas/schema.ts`                             | `canvas_snapshots` table + zod insert/select schemas                                                                                                                                                               |
| `lib/canvas/validators.ts`                         | `PutCanvasBody` — `document` must be a plain record                                                                                                                                                                |
| `lib/canvas/queries.ts`                            | `getCanvasSnapshotForUser`, `threadOwnedByUser`, `upsertCanvasSnapshot`, `deleteCanvasSnapshot`                                                                                                                    |
| `lib/canvas/snapshot.ts`                           | `EMPTY_DOCUMENT` (initial `{ nodes: [], edges: [] }`) + thread-id guards                                                                                                                                           |
| `lib/canvas/types.ts`                              | `CanvasDocumentT` — typed `{ nodes: CanvasNode[], edges: Edge[] }` shape                                                                                                                                           |
| `lib/canvas/auto-save.ts`                          | `useCanvasAutoSave` hook — debounce + sendBeacon, reads live React Flow state                                                                                                                                      |
| `lib/canvas/context.tsx`                           | `CanvasProvider` + `useCanvas` + `useCanvasRegister` (cross-component bridge)                                                                                                                                      |
| `app/api/canvas/[threadId]/route.ts`               | GET / PUT / DELETE — `withAuth`, 404 on non-owned                                                                                                                                                                  |
| `components/chat/CanvasToggleButton.tsx`           | Header toggle, `hidden md:flex`                                                                                                                                                                                    |
| `components/chat/CanvasEditor.tsx`                 | React Flow wrapper — `onInit` registers the bridge, `setNodes`/`setEdges` on thread change, three custom node types (`text` / `generate` / `preview`)                                                              |
| `components/chat/CanvasSplitLayout.tsx`            | Full-canvas wrapper: `<CanvasEditor>` fills the area, `<Thread>` overlays as a translucent right-edge card; collapse icon inside the card, chat-bubble button outside when collapsed. Wrapped in `CanvasProvider`. |
| `backend/tool/image/generate-image.ts`             | `generate_image` LangGraph tool (Pollinations default, fal.ai via `FAL_KEY`)                                                                                                                                       |
| `lib/image/{types,pollinations,fal,index}.ts`      | `ImageBackend` interface + per-platform factories + `pickImageBackend()`                                                                                                                                           |
| `components/tool-ui/image/generate-image-card.tsx` | Image card — auto-adds Preview nodes to the canvas (consumes `useCanvas()`), `onError` fallback to placeholder                                                                                                     |

## Why these choices

- **One table, not per-node diffs.** React Flow's persistence model is "save the whole state." A diff table would need a merge function that re-implements xyflow's reconciliation — a complexity tax for no correctness gain. One PUT, one GET, one DELETE.
- **FK cascade over a parallel sweep.** Archiving / deleting a thread already wipes langgraph checkpointer rows + observability spans via cascades. Adding a third cascade for canvas is the same pattern, not new code.
- **No re-validation server-side.** React Flow's loader IS the validator. A zod schema mirroring `Node`/`Edge` drifts as xyflow evolves (every minor version adds / removes node props). The route only checks "non-null object" — anything malformed gets caught when the _next_ client calls `setNodes`.
- **Debounce + sendBeacon, not autosave-on-interval.** A 2s debounce keeps drag-induced saves to one write. `sendBeacon` covers the one failure mode debounce can't: the user closing the tab mid-debounce.
- **`FAL_KEY` opt-in for fal.ai.** Default path is Pollinations (free, no key, image-to-image via `gptimage` model). `FAL_KEY` flips `pickImageBackend()` to fal.ai for users who want higher quality. Both share the same `ImageBackend` shape, so the tool wrapper doesn't change.
- **`kind: "pic"`** instead of billing on a flat per-image rate. Image-gen pricing varies wildly across models (flux schnell vs. flux pro vs. imagen-4) — tagging with a `kind` lets admins register each model under the same kind with different `inputPer1k` / `outputPer1k`, and the credit callback already handles per-kind attribution via `agentName` / `modelName`.

## Future work

- **Yjs CRDT multiplayer.** Two users on the same thread both editing — `@xyflow/react` supports it via `useYjsSync`. Out of scope for the current MVP; the design (one-row snapshot) accommodates it by switching the `document` write to a periodic Yjs update log instead.
- **Per-image kind for credit attribution.** Today the tool call's tokens go through the standard LLM credit path; the actual image-generation call to FAL / Pollinations is NOT metered. Add a parallel `image_usage_log` if/when fal.ai costs become non-trivial.
- **Drag-in image upload from canvas.** React Flow doesn't ship drop handlers out of the box; wire an `<Editor>`-level `onDrop` to the R2 attachment pipeline so dropped images land as Preview nodes instead of bloating the JSONB document.
