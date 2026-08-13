"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { CanvasDocumentT } from "@/lib/canvas/types";
import { isPlaceholderThread } from "@/lib/canvas/thread-id";

// ponytail: debounced canvas snapshot writer. React Flow version.
// Caller passes `getDocumentAction` — a stable getter that returns
// `{ nodes, edges }` from the live React Flow state. We PUT it as
// JSON to /api/canvas/:threadId. The same debounce / beforeunload /
// pagehide / unmount-flush logic as before, just reading from
// React Flow's state instead of tldraw's store.
//
// Every outgoing path guards on `isPlaceholderThread` so a stray
// aUI `__LOCAL_<rand>` id never creates an orphan row or spams the
// server with PUTs against a non-existent thread.

const DEBOUNCE_MS = 2000;

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

type Args = {
  threadId: string | null;
  getDocumentAction: () => CanvasDocumentT | undefined;
  enabled?: boolean;
};

export function useCanvasAutoSave({ threadId, getDocumentAction, enabled = true }: Args) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ponytail: latest-tick-wins — overwrite the queued payload on each
  // store change so the next flush sends the freshest document. We
  // hold it in a ref instead of state to avoid re-rendering on every
  // keystroke / drag.
  const pendingRef = useRef<CanvasDocumentT | undefined>(undefined);
  const dirtyRef = useRef(false);

  const send = useCallback(
    async (payload: CanvasDocumentT) => {
      if (!threadId || isPlaceholderThread(threadId)) return;
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

  // ponytail: called by the canvas component on every node/edge
  // change. Resets the debounce window each call so a continuous
  // drag fires ONE save 2s after the user stops moving — not 100s
  // while they drag.
  const schedule = useCallback(() => {
    if (!enabled || !threadId || isPlaceholderThread(threadId)) return;
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
      if (!dirtyRef.current || !threadId || isPlaceholderThread(threadId)) return;
      const payload = pendingRef.current;
      if (!payload) return;
      const blob = new Blob([JSON.stringify({ document: payload })], {
        type: "application/json",
      });
      // ponytail: sendBeacon returns false when the browser refuses
      // (e.g. payload > 64KB). React Flow documents are small
      // (a few hundred bytes of node/edge JSON) so this is rare,
      // but fall back to a keepalive fetch for safety.
      const ok = navigator.sendBeacon(`/api/canvas/${threadId}`, blob);
      if (!ok) {
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

  return { status, schedule, flush };
}

// ponytail: shared serializer — converts a React Flow `nodes`/`edges`
// array to the `{ nodes, edges }` shape we persist. The persisted
// shape strips React Flow's runtime fields (selected, dragging, etc.)
// and keeps only `id`, `position`, and `data` per node, plus `id` /
// `source` / `target` / handles per edge. We cast through unknown to
// a plain record because React Flow's typed nodes have a generic
// `data` we can't narrow at this layer — the renderer reads `data`
// as `{ type, fields }` per CanvasNodeData.
export function toCanvasDocument(nodes: Node[], edges: Edge[]): CanvasDocumentT {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      position: { x: n.position.x, y: n.position.y },
      data: {
        type: ((n.data as { type?: string })?.type ?? (n.type as string) ?? "text") as
          | "text"
          | "generate"
          | "preview",
        fields: ((n.data as { fields?: Record<string, unknown> })?.fields ?? {}) as Record<
          string,
          unknown
        >,
      },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      // ponytail: persist `data.system` so reloads preserve the lock.
      // Without this, a system edge becomes user-deletable after a
      // page refresh — the user wouldn't be able to disconnect
      // Generate from its Preview, which is the whole point.
      data:
        e.data && (e.data as { system?: boolean }).system === true ? { system: true } : undefined,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
    })),
  };
}
