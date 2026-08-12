"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ponytail: debounced canvas snapshot writer.
//   - getDocumentAction (renamed per the "use client" rule that
//     function props from server → client must look like Server
//     Actions): caller passes a getter so we read the latest store
//     snapshot inside the debounced fn, never a stale closure.
//   - threadId is the canvas row key. Drops to no-op when null (e.g.
//     the user hasn't picked a thread yet).
//   - beforeunload + visibilitychange flush via sendBeacon — JSON
//     payload, POST /api/canvas/:threadId. sendBeacon survives
//     navigation without blocking the unload.
//
// We expose `flush()` so callers can force a save (cover image attach,
// "save" button). `status` is a simple state machine for UI badges
// (idle → pending → saving → saved | error).

const DEBOUNCE_MS = 2000;

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

type Args = {
  threadId: string | null;
  getDocumentAction: () => Record<string, unknown> | undefined;
  enabled?: boolean;
};

export function useCanvasAutoSave({ threadId, getDocumentAction, enabled = true }: Args) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  // ponytail: latest-tick-wins — overwrite the queued payload on each
  // store change so the next flush sends the freshest document. We
  // hold it in a ref instead of state to avoid re-rendering on every
  // keystroke / drag.
  const pendingRef = useRef<Record<string, unknown> | undefined>(undefined);
  const dirtyRef = useRef(false);

  const send = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!threadId) return;
      setStatus("saving");
      try {
        const res = await fetch(`/api/canvas/${threadId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: payload }),
        });
        if (!res.ok) {
          // ponytail: 404 = thread disappeared / not owned — drop the
          // pending payload so we don't keep retrying against a dead
          // thread. 401 = session gone, same.
          if (res.status === 401 || res.status === 404) {
            dirtyRef.current = false;
            pendingRef.current = undefined;
            setStatus("error");
            return;
          }
          setStatus("error");
          return;
        }
        dirtyRef.current = false;
        pendingRef.current = undefined;
        setStatus("saved");
        // ponytail: revert to idle after a beat so the UI doesn't
        // stick on a green "saved" badge forever.
        setTimeout(() => {
          setStatus((s) => (s === "saved" ? "idle" : s));
        }, 1500);
      } catch {
        setStatus("error");
      }
    },
    [threadId],
  );

  const flush = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!dirtyRef.current) return;
    const payload = pendingRef.current;
    if (!payload) return;
    dirtyRef.current = false;
    pendingRef.current = undefined;
    void send(payload);
  }, [send]);

  // ponytail: called by the canvas component on every store change.
  // Resets the debounce window each call so a continuous drag fires
  // ONE save 2s after the user stops moving — not 100s while they
  // drag.
  const schedule = useCallback(() => {
    if (!enabled || !threadId) return;
    pendingRef.current = getDocumentAction();
    if (!pendingRef.current) return;
    dirtyRef.current = true;
    setStatus("pending");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      flush();
    }, DEBOUNCE_MS);
  }, [enabled, threadId, getDocumentAction, flush]);

  // ponytail: beforeunload + pagehide flush via sendBeacon. JSON
  // payload to the same endpoint. pagehide is the modern replacement
  // for beforeunload on iOS / back-forward cache, so we register
  // both. We avoid state updates in the unload handler (the page is
  // already going away) — only fire-and-forget.
  useEffect(() => {
    if (!enabled) return;
    const beacon = () => {
      if (!dirtyRef.current || !threadId) return;
      const payload = pendingRef.current;
      if (!payload) return;
      const blob = new Blob([JSON.stringify({ document: payload })], {
        type: "application/json",
      });
      // ponytail: sendBeacon returns false when the browser refuses
      // (e.g. payload > 64KB). Our snapshots are tldraw JSON
      // documents — small — but a future "paste 100 images" flow
      // could blow it. fall back to fetch with keepalive, which has
      // no hard cap but blocks unload until the request resolves.
      const ok = navigator.sendBeacon(`/api/canvas/${threadId}`, blob);
      if (!ok) {
        // ponytail: best-effort flush. sendBeacon returned false (payload
        // > 64KB is the common cause); fall through to a keepalive
        // fetch. The handler fires during page-unload transitions and
        // any of those can abort the request before it lands — swallow
        // the rejection so an aborted flush doesn't surface as a
        // "Failed to fetch" in the console. The next debounced save
        // reconciles any drop.
        void fetch(`/api/canvas/${threadId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: payload }),
          keepalive: true,
        }).catch(() => undefined);
      }
      dirtyRef.current = false;
      pendingRef.current = undefined;
    };
    window.addEventListener("beforeunload", beacon);
    window.addEventListener("pagehide", beacon);
    return () => {
      window.removeEventListener("beforeunload", beacon);
      window.removeEventListener("pagehide", beacon);
    };
  }, [enabled, threadId]);

  // ponytail: cancel the in-flight debounce on unmount AND flush any
  // pending payload via sendBeacon. The previous version dropped
  // pending edits on a fast unmount — when key={threadId} forces a
  // remount on thread switch, any unsaved changes from the old
  // thread would otherwise vanish (debounce timer cleared before
  // it could fire). sendBeacon survives the unmount; fetch keepalive
  // is the fallback for blobs > 64KB. threadId is included so the
  // closure captures the latest value, not a stale one.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (!dirtyRef.current || !threadId || !pendingRef.current) return;
      const payload = pendingRef.current;
      const blob = new Blob([JSON.stringify({ document: payload })], {
        type: "application/json",
      });
      const ok = navigator.sendBeacon(`/api/canvas/${threadId}`, blob);
      if (!ok) {
        // ponytail: best-effort flush. sendBeacon returned false (payload
        // > 64KB is the common cause); fall through to a keepalive
        // fetch. The handler fires during page-unload transitions and
        // any of those can abort the request before it lands — swallow
        // the rejection so an aborted flush doesn't surface as a
        // "Failed to fetch" in the console. The next debounced save
        // reconciles any drop.
        void fetch(`/api/canvas/${threadId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: payload }),
          keepalive: true,
        }).catch(() => undefined);
      }
      dirtyRef.current = false;
      pendingRef.current = undefined;
    };
  }, [threadId]);

  return { status, schedule, flush, inflight: inflightRef.current };
}
