# Canvas (Design)

The app is chat-first; when the user expands the canvas, the layout flips to **full-canvas mode** — tldraw fills the entire main area, and the existing assistant-ui `<Thread>` floats on top as a translucent card (backdrop-blurred, ~360–400 px wide, anchored to the right edge). This file is the **design doc** — layout, data model, auto-save cadence, the image-generation tool. For HTTP endpoints see [`docs/APIS.md`](./APIS.md) § Canvas.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Header: [Sidebar] [ThreadTitle]              [Canvas toggle]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                                                             │
│                  tldraw (CanvasEditor)                      │
│                  fills the full main area                   │
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
- The `<Thread>` is mounted _inside_ the canvas overlay (`CanvasSplitLayout`) — toggling off the canvas teardown unmounts the editor (and its tldraw listeners) and switches to plain `<Thread />`. `key={threadId}` on `CanvasEditor` forces a remount per thread so tldraw's additive `loadSnapshot` doesn't leak shapes across threads.
- Collapse control lives INSIDE the chat card at its bottom-left (`PanelRightCloseIcon`, `size-5`); collapsed → chat-bubble button at the viewport's bottom-right (`MessageCircleIcon`, `size-10`). Both transitions are CSS-driven (`transition-all duration-200 ease-out`) on `translate-x`/`opacity`/`scale` — no `tw-animate-css` keyframes (they don't pin final state when the element stays mounted).
- tldraw's built-in chrome (`PageMenu`, `MainMenu`, `StylePanel`) is nulled out via `<Tldraw components={...}>` — 1 thread = 1 page, no multi-page switcher. Toolbar / NavigationPanel / Minimap are kept as user affordances.
- The SDK license key is read from `window.__CONFIG__.TLDRAW_LICENSE_KEY` (set by `app/layout.tsx` from `process.env.TLDRAW_LICENSE_KEY`, rule #12) and passed via the `licenseKey` prop on `<Tldraw>`. Without a key, tldraw shows a bottom-right watermark that the SDK enforces at runtime; setting `TLDRAW_LICENSE_KEY` removes it.

## Data model

One table: `canvas_snapshots`. One row per thread.

```ts
{
  threadId: string; // PK + FK → threads.id (ON DELETE CASCADE)
  document: Record<string, unknown>; // tldraw TLDocument blob (jsonb)
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

- `document` is the full `editor.store.getSnapshot().document` payload — tldraw's "document" scope (shapes + pages + bindings + asset refs). We don't store `session` (camera, page state) or `presence` (cursors) — those scopes are per-browser in localStorage per tldraw's SPEC.
- Cascade on thread delete: archiving a thread from the sidebar wipes its canvas row automatically (the FK does the work; no parallel canvas query).
- We deliberately don't re-validate the `document` server-side — tldraw's loader validates on `loadSnapshot()`. Round-tripping through zod would duplicate validation that drifts when tldraw evolves (see `lib/canvas/validators.ts`).

## Auto-save

`lib/canvas/auto-save.ts` — debounced PUT with beforeunload flush.

- **Debounce 2s** (`DEBOUNCE_MS = 2000`). Every `editor.store.listen(..., { scope: "document" })` event resets the timer, so a continuous drag fires ONE save 2s after the user stops moving — not 100s while they drag.
- **last-write-wins**. A ref holds the latest document; on every change we overwrite it. The next flush sends the freshest payload.
- **beforeunload + pagehide** flush via `navigator.sendBeacon`. JSON blob, same endpoint. `sendBeacon` returns false when the browser refuses (> 64KB) — we fall back to `fetch(... keepalive: true)` so nothing is silently dropped (a future "paste 100 images" flow could blow the cap).
- **Status state machine**: `idle → pending → saving → saved | error`. UI badge reads from `status`. 401/404 on save drops the pending payload (thread vanished or session expired — no point retrying).

## Image generation tool

`backend/tool/image/generate-image.ts` — `generate_image` LangGraph tool, registered in `CHAT_TOOLS`. Unconditional registration: fal.ai is paid, but the tool's impl falls back to a `placehold.co` mock when `FAL_KEY` is missing, so local dev / demos still work end-to-end without the key. This is a _mock-first_ pattern, distinct from `fetch_url`'s rule #10 exemption (r.jina.ai genuinely serves unauthenticated traffic on the free tier — no fallback needed).

- **With `FAL_KEY`**: POST to `https://fal.run/fal-ai/flux/schnell` with `{ prompt, aspect_ratio }`. Returns `{ url, mock: false, prompt, aspect_ratio }`.
- **Without `FAL_KEY`**: the impl returns a deterministic `placehold.co` URL with `mock: true`. End-to-end canvas flow still works on local dev; the UI shows a "demo image" badge so users aren't confused about why their prompt became a stock photo.
- Charges go through the existing credit system using the new `kind: "pic"` model kind (added to `lib/credit/zod.ts modelKindSchema` + `lib/provider/schema.ts ModelKind`). Admins tag image-gen providers with `kind: ["pic"]` so the per-kind rate config routes correctly.

The tool result is rendered by `components/tool-ui/image/generate-image-card.tsx` (registered in `toolkit.tsx`). The card uses `useCanvas()` from `lib/canvas/context.tsx` to bridge into the live tldraw editor — see [Cross-component wiring](#cross-component-wiring).

## Cross-component wiring

The right-hand `<Thread>` panel and the left-hand tldraw editor live in different component trees. A tiny context (`lib/canvas/context.tsx`) bridges them:

- `CanvasProvider` lives in `CanvasSplitLayout` and exposes two contexts: `useCanvas()` (read access for tool-ui cards) and `useCanvasRegister()` (the mount-time setter for `CanvasEditor`).
- `CanvasEditor` calls `register(editor)` in `onMount` and `register(null)` on unmount. Tool cards read `useCanvas()` → `{ ready, insertImage({ url, w?, h? }) }`.
- When the canvas is closed, `useCanvas()` returns the no-op default (`ready: false, insertImage: () => false`). The image card renders the button as disabled with the label "Open canvas to add".
- Default size is 512×512. The card scales to 384×512 (portrait) or 512×384 (landscape) when `aspect_ratio` is set, dropping the shape at `editor.getViewportPageBounds().center`.

## Component map

| File                                               | Role                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/canvas/schema.ts`                             | `canvas_snapshots` table + zod insert/select schemas                                                                                                                                                               |
| `lib/canvas/validators.ts`                         | `PutCanvasBody` — `document` must be a plain record                                                                                                                                                                |
| `lib/canvas/queries.ts`                            | `getCanvasSnapshotForUser`, `threadOwnedByUser`, `upsertCanvasSnapshot`, `deleteCanvasSnapshot`                                                                                                                    |
| `lib/canvas/snapshot.ts`                           | tldraw `getSnapshot` / `loadSnapshot` re-exports + `EMPTY_SNAPSHOT`                                                                                                                                                |
| `lib/canvas/auto-save.ts`                          | `useCanvasAutoSave` hook — debounce + sendBeacon                                                                                                                                                                   |
| `lib/canvas/context.tsx`                           | `CanvasProvider` + `useCanvas` + `useCanvasRegister` (cross-component bridge)                                                                                                                                      |
| `app/api/canvas/[threadId]/route.ts`               | GET / PUT / DELETE — `withAuth`, 404 on non-owned                                                                                                                                                                  |
| `components/chat/CanvasToggleButton.tsx`           | Header toggle, `hidden md:flex`                                                                                                                                                                                    |
| `components/chat/CanvasEditor.tsx`                 | tldraw wrapper — `onMount` subscribes to store + registers editor, `loadSnapshot` on thread change, hides `PageMenu` / `MainMenu` / `StylePanel`                                                                   |
| `components/chat/CanvasSplitLayout.tsx`            | Full-canvas wrapper: `<CanvasEditor>` fills the area, `<Thread>` overlays as a translucent right-edge card; collapse icon inside the card, chat-bubble button outside when collapsed. Wrapped in `CanvasProvider`. |
| `backend/tool/image/generate-image.ts`             | `generate_image` LangGraph tool (mock-first via `placehold.co`, real fal.ai flux/schnell when `FAL_KEY` is set)                                                                                                    |
| `components/tool-ui/image/generate-image-card.tsx` | Image card with "Add to canvas" button (consumes `useCanvas()`)                                                                                                                                                    |

## Why these choices

- **One table, not per-shape diffs.** tldraw's persistence model is "save the whole document." A diff table would need a merge function that re-implements tldraw's reconciliation — a complexity tax for no correctness gain. One PUT, one GET, one DELETE.
- **FK cascade over a parallel sweep.** Archiving / deleting a thread already wipes langgraph checkpointer rows + observability spans via cascades. Adding a third cascade for canvas is the same pattern, not new code.
- **No re-validation server-side.** tldraw's loader IS the validator. A zod schema mirroring TLDocument drifts as tldraw evolves (every minor version adds / removes shape props). The route only checks "non-null object" — anything malformed gets caught when the _next_ client calls `loadSnapshot`.
- **Debounce + sendBeacon, not autosave-on-interval.** A 2s debounce keeps drag-induced saves to one write. `sendBeacon` covers the one failure mode debounce can't: the user closing the tab mid-debounce.
- **Lazy-register on `FAL_KEY`** mirrors `search_web → JINA_API_KEYS` and `get_NFT_holdings → ALCHEMY_API_KEY`. Local dev without a key still boots the canvas flow (mock placeholder); production adds the key to enable real generation.
- **`kind: "pic"`** instead of billing on a flat per-image rate. Image-gen pricing varies wildly across models (flux schnell vs. flux pro vs. imagen-4) — tagging with a `kind` lets admins register each model under the same kind with different `inputPer1k` / `outputPer1k`, and the credit callback already handles per-kind attribution via `agentName` / `modelName`.

## Future work

- **Yjs CRDT multiplayer.** Two users on the same thread both editing — `TLDocument` supports it via `createTLStore({ ..., collaboration: { ... } })`. Out of scope for the current MVP; the design (one-row snapshot) accommodates it by switching the `document` write to a periodic Yjs update log instead.
- **Per-shape kind for credit attribution.** Today the tool call's tokens go through the standard LLM credit path; the actual image-generation call to FAL is NOT metered. Add a parallel `image_usage_log` if/when fal.ai costs become non-trivial.
- **Drag-in image upload from canvas.** tldraw supports paste / drop natively; we just need to wire `defaultHandleExternalFileContent` to the R2 attachment pipeline so dropped images don't bloat the JSONB document.
