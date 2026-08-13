"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { Edge, Node } from "@xyflow/react";

// ponytail: bridge between tool-ui cards (rendered in the right
// <Thread>) and the React Flow editor (only mounted when canvas is
// open). The bridge now carries two things: the React state setters
// (`setNodes` / `setEdges`) AND a `schedule` function. The instance
// is NOT part of the bridge anymore — xyflow's `inst.setNodes` from
// the instance bypasses `onNodesChange` (it only mutates React Flow's
// internal store without notifying the controlled prop). Routing all
// mutations through the React state setters means `onNodesChange`
// stays the single source of truth and `schedule()` (auto-save
// debounce) fires on every mutation.

export type AddNodeOpts = {
  type: "text" | "generate" | "preview";
  // node-type-specific data fields. For "text" the field is
  // { text? }. For "generate" the fields are { text?, aspectRatio?,
  // num? } (text is the prompt body, others are tool args). For
  // "preview" the field is { url? }. We pass through as
  // `Record<string, unknown>` and let the node component validate
  // on render.
  fields?: Record<string, unknown>;
  // ponytail: position in flow space. If omitted, drop at the
  // current viewport center so the user always sees the new node.
  position?: { x: number; y: number };
};

export type InsertImageOpts = {
  url: string;
  // ponytail: image dimensions. We trust the LLM schema for these
  // and don't fetch the image to measure. The Preview node renders
  // the same dims the user requested.
  w?: number;
  h?: number;
  // ponytail: drop position in flow space. When the caller knows where
  // it wants the preview (e.g. the generate_image tool card lays it
  // out below the upstream Generate node), it can hand the coords in
  // and skip the viewportCenter default. Omitted = viewport center.
  position?: { x: number; y: number };
};

export type SystemEdgeOpts = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  // ponytail: the system edge is locked — the user can't delete it
  // from the canvas UI. Used by the agent to wire Generate →
  // Preview after a tool call. A custom React Flow `onEdgesDelete`
  // handler in CanvasEditor rejects removal of any edge whose
  // `data.system === true`.
  system?: boolean;
};

// ponytail: registration payload. The canvas (CanvasEditorInner)
// mounts, calls `register(...)` once with its setters and a viewport
// helper. Cards read these via `useCanvas()`. The setters run inside
// React's reconciler, so `onNodesChange` / `onEdgesChange` still fire
// downstream — auto-save stays in sync without the cards needing to
// know about it.
type Registration = {
  setNodes: (updater: (nodes: Node[]) => Node[]) => void;
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void;
  schedule: () => void;
  // ponytail: viewport center helper. Cards don't have a useReactFlow
  // reference; the canvas exposes this so they can drop new nodes
  // without importing React Flow.
  viewportCenter: () => { x: number; y: number };
  // ponytail: pan/zoom the canvas to center a given node. Used by the
  // directive-chip renderer for `:text[...]{nodeId=...}` mentions to
  // jump to the source Text node when the user clicks the chip in
  // their own message bubble.
  focusNode: (nodeId: string) => void;
};

export type CanvasApi = {
  ready: boolean;
  insertImage: (opts: InsertImageOpts) => string | null;
  // ponytail: drop a node on the canvas. Returns the new node id
  // (so the caller can wire edges / write back data later) or null
  // if the canvas isn't mounted. Use this from the agent (e.g.
  // generate_image tool UI card to spawn the pipeline).
  addNode: (opts: AddNodeOpts) => string | null;
  // ponytail: connect two nodes with an edge. Returns the new
  // edge id, or null on failure. `system: true` locks the edge
  // from user-driven deletion.
  addEdge: (opts: SystemEdgeOpts) => string | null;
  // ponytail: patch a node's data fields. The renderer re-renders
  // on data change. Returns true on success, false if the node id
  // is unknown.
  updateNodeData: (id: string, fields: Record<string, unknown>) => boolean;
  // ponytail: track the most recently clicked Generate node. The
  // generate_image tool UI card reads both the id (to wire a system
  // edge) and the position + size (to drop the Preview below the
  // source rather than at viewport center). Sticky per-session;
  // cleared on unmount.
  setSourceNode: (
    node: {
      id: string;
      position: { x: number; y: number };
      width?: number;
      height?: number;
    } | null,
  ) => void;
  getSourceNode: () => {
    id: string;
    position: { x: number; y: number };
    width?: number;
    height?: number;
  } | null;
  // ponytail: pan/zoom to a node on the canvas. No-op if the canvas
  // isn't mounted or the id is unknown. Used by directive chips to
  // navigate from a rendered message bubble back to the source.
  focusNode: (nodeId: string) => void;
};

const noopApi: CanvasApi = {
  ready: false,
  insertImage: () => null,
  addNode: () => null,
  addEdge: () => null,
  updateNodeData: () => false,
  setSourceNode: () => undefined,
  getSourceNode: () => null,
  focusNode: () => undefined,
};

const CanvasContext = createContext<CanvasApi | null>(null);
// ponytail: separate register context so consumers don't re-render
// on every editor tick. The setter stores the registration in a ref
// (no state) so the API surface doesn't flip `ready` on every mount.
const CanvasRegisterContext = createContext<(reg: Registration | null) => void>(() => {});

export function CanvasProvider({ children }: { children: ReactNode }) {
  const regRef = useRef<Registration | null>(null);
  // ponytail: `ready` is exposed via the API as a boolean, but we
  // derive it from `regRef.current` lazily inside the API factories
  // below — re-rendering the provider when registration flips would
  // re-render every card on every canvas open/close. The cards only
  // care when they actually try to mutate, which is what the early
  // `if (!reg) return null` checks below guard.
  const [, forceUpdate] = useState(0);
  const ready = (): boolean => regRef.current !== null;
  // ponytail: latest Generate-node id that fired "Send". Read by
  // generate_image tool UI card to wire a system edge between the
  // source Generate and the new Preview. Module-level ref so the
  // card can read it without prop drilling.
  const sourceNodeRef = useRef<{
    id: string;
    position: { x: number; y: number };
    width?: number;
    height?: number;
  } | null>(null);

  // ponytail: returns the new preview node id so callers can wire a
  // system edge to it. Dropped at the viewport center; the caller
  // (a tool UI card) reads the id and chains `addEdge` right after.
  const insertImage = useCallback((opts: InsertImageOpts): string | null => {
    const reg = regRef.current;
    if (!reg) return null;
    const w = opts.w ?? 512;
    const h = opts.h ?? 512;
    const vp = reg.viewportCenter();
    const id = crypto.randomUUID();
    // ponytail: caller-supplied position wins (used by the
    // generate_image card to drop the preview below the source
    // Generate node). Fall back to viewport-center when nothing
    // was passed — matches the original behavior for any consumer
    // that doesn't know where it wants the node.
    const position = opts.position ?? { x: vp.x - w / 2, y: vp.y - h / 2 };
    reg.setNodes((nodes) => [
      ...nodes,
      {
        id,
        type: "preview",
        position,
        data: { type: "preview", fields: { url: opts.url, w, h } },
      } as Node,
    ]);
    reg.schedule();
    return id;
  }, []);

  const addNode = useCallback((opts: AddNodeOpts): string | null => {
    const reg = regRef.current;
    if (!reg) return null;
    const vp = reg.viewportCenter();
    const id = crypto.randomUUID();
    const position = opts.position ?? { x: vp.x - 130, y: vp.y - 100 };
    reg.setNodes((nodes) => [
      ...nodes,
      {
        id,
        type: opts.type,
        position,
        data: { type: opts.type, fields: opts.fields ?? {} },
      } as Node,
    ]);
    reg.schedule();
    return id;
  }, []);

  const addEdge = useCallback((opts: SystemEdgeOpts): string | null => {
    const reg = regRef.current;
    if (!reg) return null;
    const id = crypto.randomUUID();
    reg.setEdges((edges) => [
      ...edges,
      {
        id,
        source: opts.source,
        target: opts.target,
        sourceHandle: opts.sourceHandle ?? null,
        targetHandle: opts.targetHandle ?? null,
        data: { system: opts.system === true },
      } as Edge,
    ]);
    reg.schedule();
    return id;
  }, []);

  const updateNodeData = useCallback((id: string, fields: Record<string, unknown>): boolean => {
    const reg = regRef.current;
    if (!reg) return false;
    let found = false;
    reg.setNodes((nodes) =>
      nodes.map((n) => {
        if (n.id !== id) return n;
        found = true;
        return {
          ...n,
          data: {
            ...(n.data as Record<string, unknown>),
            fields: {
              ...(n.data as { fields?: Record<string, unknown> }).fields,
              ...fields,
            },
          },
        } as Node;
      }),
    );
    if (found) reg.schedule();
    return found;
  }, []);

  const setSourceNode = useCallback(
    (
      node: {
        id: string;
        position: { x: number; y: number };
        width?: number;
        height?: number;
      } | null,
    ) => {
      sourceNodeRef.current = node;
    },
    [],
  );
  const getSourceNode = useCallback(() => sourceNodeRef.current, []);

  const register = useCallback((reg: Registration | null) => {
    regRef.current = reg;
    // ponytail: force a render so consumers re-read `useCanvas()`
    // with the new `ready` flag. Without this, cards mounted before
    // the canvas registers would never see `ready: true`. Cards
    // mounted AFTER the canvas registered never see the flip either
    // (they read on mount) — they just call the noop API. The forced
    // render only affects cards mounted BEFORE registration, i.e.
    // the common case where the chat is open and the canvas opens.
    forceUpdate((n) => n + 1);
  }, []);

  return (
    <CanvasRegisterContext.Provider value={register}>
      <CanvasContext.Provider
        value={{
          ready: ready(),
          insertImage,
          addNode,
          addEdge,
          updateNodeData,
          setSourceNode,
          getSourceNode,
          focusNode: (nodeId: string) => {
            const reg = regRef.current;
            if (!reg) return;
            reg.focusNode(nodeId);
          },
        }}
      >
        {children}
      </CanvasContext.Provider>
    </CanvasRegisterContext.Provider>
  );
}

export function useCanvas(): CanvasApi {
  return useContext(CanvasContext) ?? noopApi;
}

export function useCanvasRegister(): (reg: Registration | null) => void {
  return useContext(CanvasRegisterContext);
}
