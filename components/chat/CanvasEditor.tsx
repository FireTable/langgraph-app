"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tldraw, type Editor, type TLEditorSnapshot } from "tldraw";
import "tldraw/tldraw.css";

import { useCanvasAutoSave, type SaveStatus } from "@/lib/canvas/auto-save";
import { useCanvasRegister } from "@/lib/canvas/context";
import { EMPTY_SNAPSHOT, getSnapshot, loadSnapshot } from "@/lib/canvas/snapshot";

// ponytail: tldraw license is domain-locked (not a secret). Read from
// window.__CONFIG__ in the browser (rule #12) — the env var lives in
// server-side process.env and is injected by app/layout.tsx. On the
// server the same `process.env.X` reads return undefined, but
// CanvasEditor only renders after `dynamic({ ssr: false })`, so the
// browser branch is the one that actually fires.
const isBrowser = typeof window !== "undefined";
const TLDRAW_LICENSE_KEY = isBrowser
  ? window.__CONFIG__?.TLDRAW_LICENSE_KEY
  : process.env.TLDRAW_LICENSE_KEY;

// ponytail: tldraw lives behind `dynamic({ ssr: false })` — its wasm /
// canvas / image-decoding deps are heavy and would balloon the server
// bundle for no reason. Parent layout imports the wrapper, never tldraw
// directly. Initial-load fetch resolves the snapshot, then `loadSnapshot`
// merges it into the editor. We register a store-change listener that
// funnels every change into the debounced auto-save.

export type CanvasEditorProps = {
  threadId: string;
  // ponytail: renamed per the "use client" rule that function props
  // must look like Server Actions. The parent uses this to surface
  // a "Saved / Saving…" badge in the layout chrome.
  onStatusChangeAction?: (status: SaveStatus) => void;
};

export function CanvasEditor({ threadId, onStatusChangeAction }: CanvasEditorProps) {
  const editorRef = useRef<Editor | null>(null);
  // ponytail: register the live editor with the cross-component bridge
  // (lib/canvas/context.tsx). Tool-ui cards call `useCanvas().insertImage`
  // which routes through this registered editor. Unregister on unmount
  // so a stale editor isn't reachable after the canvas is closed.
  const register = useCanvasRegister();
  useEffect(() => {
    return () => register(null);
  }, [register]);
  // ponytail: a stable getter for the latest document. The auto-save
  // hook calls this inside the debounce flush — a closure-bound value
  // would freeze on the snapshot at hook-init time, so we read the
  // live store instead. The tldraw `document` field is a typed store
  // snapshot; we cast through unknown to the looser JSONB record
  // shape the API persists.
  const getDocumentAction = useCallback(
    () =>
      editorRef.current
        ? (getSnapshot(editorRef.current.store).document as unknown as Record<string, unknown>)
        : undefined,
    [],
  );
  const { status, schedule } = useCanvasAutoSave({
    threadId,
    getDocumentAction,
    enabled: true,
  });

  // ponytail: bubble the status up so the parent can render a tiny
  // "saved / saving…" badge without us owning the badge component.
  useEffect(() => {
    onStatusChangeAction?.(status);
  }, [status, onStatusChangeAction]);

  // ponytail: load the saved snapshot once when the thread id changes.
  // tldraw's `loadSnapshot` is additive — feeding EMPTY_SNAPSHOT first
  // would clobber shapes on a subsequent load. We ONLY call it after a
  // successful fetch; a 404 means "no row yet, start blank", so we skip
  // the call entirely. First save creates the row (upsert path).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void (async () => {
      // ponytail: any throw inside (fetch / json / loadSnapshot) must
      // still land us in `setReady(true)` — otherwise the "Loading
      // canvas…" overlay sticks forever and the user can't draw on
      // an empty board. tldraw's loadSnapshot can throw on a corrupt
      // row; the safe path is "skip the load, mark ready, let the
      // next save rewrite the row". Errors surface in the console
      // for debugging — no UI surface needed.
      try {
        const res = await fetch(`/api/canvas/${threadId}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { document: Record<string, unknown> | null };
          if (body.document && Object.keys(body.document).length > 0 && editorRef.current) {
            // ponytail: loadSnapshot wants a full TLEditorSnapshot (document
            // + session + ...). We only persisted `document`. Merge with
            // EMPTY_SNAPSHOT to satisfy the type, then call — tldraw's
            // `session` scope stays per-browser in localStorage anyway
            // (see lib/canvas/schema.ts comment). Double cast: our stored
            // shape is a plain record (JSONB), tldraw wants its typed
            // TLStoreSnapshot; the runtime accepts the looser record.
            const snapshot: Partial<TLEditorSnapshot> = {
              document: body.document as unknown as TLEditorSnapshot["document"],
              session: EMPTY_SNAPSHOT.session,
            };
            loadSnapshot(editorRef.current.store, snapshot);
          }
        }
      } catch (err) {
        console.error("CanvasEditor: failed to hydrate snapshot", err);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // ponytail: after a snapshot loads, fit the camera to the content.
  // Skip on empty canvases (zoomToFit on zero shapes collapses the
  // camera to a degenerate state). Animation duration 0 keeps it
  // instant — the user just toggled the canvas on, no extra motion.
  // Subsequent user pans/zooms persist via tldraw's `session` scope
  // and aren't disturbed; this fires only on thread switch.
  //
  // After zoomToFit lands, dial the zoom back 25% so the framing
  // breathes (the user complained "fit is too tight, pull back").
  // 0.75 = zoomed out 25% relative to the fit zoom; immediate: true
  // skips the default animation for a single-step settle.
  useEffect(() => {
    if (!ready) return;
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getCurrentPageShapes().length > 0) {
      editor.zoomToFit({ animation: { duration: 0 } });
      // ponytail: tldraw stores zoom on the camera Vec as `.z` (not
      // `.zoom`). We pull the current camera, dial `.z` back 25%, and
      // push it back via setCamera so the framing breathes.
      const camera = editor.getCamera();
      editor.setCamera({ x: camera.x, y: camera.y, z: camera.z * 0.75 }, { immediate: true });
    }
  }, [ready, threadId]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Tldraw
        // ponytail: license key from window.__CONFIG__ / process.env
        // (see top-of-file). tldraw's <Tldraw> reads this prop directly
        // — LicenseProvider also falls back to env, but explicit prop
        // wins and is clearer in code review.
        licenseKey={TLDRAW_LICENSE_KEY}
        // ponytail: 1 thread = 1 page. Null out PageMenu so the top-left
        // page switcher is gone. MainMenu / StylePanel ship duplicate
        // menus we don't need (file menu, color pickers for shapes we
        // mostly don't add). Keep Toolbar / NavigationPanel / Minimap —
        // they're the affordances users still want.
        components={{ PageMenu: null, MainMenu: null, StylePanel: null }}
        hideUi={false}
        onMount={(editor) => {
          editorRef.current = editor;
          register(editor);
          // ponytail: subscribe to store changes. Every shape add /
          // move / edit / delete fires `change`; we funnel it into the
          // debounced auto-save. `change` is emitted with the diff; we
          // ignore the payload and just schedule a snapshot read.
          editor.store.listen(() => schedule(), { scope: "document" });
        }}
      />
      {!ready && (
        // ponytail: brief overlay while we hydrate from /api/canvas.
        // tldraw renders immediately, but we want to flash "Loading…"
        // so users don't try to edit before the saved shapes load in.
        <div className="bg-background/60 pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading canvas…
        </div>
      )}
    </div>
  );
}
