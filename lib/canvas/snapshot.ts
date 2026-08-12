// tldraw snapshot helpers — a thin wrapper over tldraw's getSnapshot /
// loadSnapshot that keeps the import surface in one place.
//
// ponytail: tldraw is heavy (it's a full canvas SDK, ~MB gzipped) —
// import it from this file only, never directly from feature code.
// Component-level usage goes through `dynamic(() => import('./...'), { ssr: false })`
// to keep Next.js server bundles free of tldraw's canvas/wasm code.

import { getSnapshot, loadSnapshot, type TLEditorSnapshot } from "tldraw";

export type { TLEditorSnapshot };

// ponytail: a blank canvas snapshot is `{ document: {}, session: {} }`.
// Returning this from a missing-row path lets the client mount tldraw
// immediately without a 404 — first save then creates the row.
export const EMPTY_SNAPSHOT: TLEditorSnapshot = {
  document: {},
  session: {},
} as unknown as TLEditorSnapshot;

export { getSnapshot, loadSnapshot };
