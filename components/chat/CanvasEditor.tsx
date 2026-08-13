"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnectEnd,
  type OnNodesChange,
  type OnEdgesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useCanvasAutoSave, toCanvasDocument } from "@/lib/canvas/auto-save";
import { useCanvas, useCanvasRegister } from "@/lib/canvas/context";
import { parseCanvasDocument } from "@/lib/canvas/snapshot";
import { isPlaceholderThread } from "@/lib/canvas/thread-id";
import { CANVAS_DIRECTIVE_GENERATE_IMAGE, CANVAS_DIRECTIVE_TEXT } from "@/lib/constants";
import { useAui } from "@assistant-ui/react";
import { ImageIcon, TypeIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// ponytail: every node-type-specific custom node reads its data via
// `data.fields` and writes back through `useReactFlow().updateNodeData`.
// Handles stay explicit (top source, bottom target) so future drag-to-
// connect wiring still has anchor points; right now `onConnect` is unset
// — the agent's generate_image UI card is the only thing that calls
// `addEdge`, and it sets `data.system = true` so deletion is locked.

const nodeShellBase =
  "min-w-[220px] rounded-lg border bg-card p-3 text-sm shadow-sm transition-colors";

// ponytail: TextNode is a sticky note. Arbitrary text the user wants
// to keep on the canvas — labels, notes, references, scratch space.
// No Send (it doesn't dispatch anywhere); connection points exist
// for future wiring (e.g. downstream text-aware nodes that want to
// read the content), but no consumer in the canvas reads from it
// today. Default size is 2× wider and 3× taller than the Generate
// node so a sticky note holds a paragraph out of the box.
function TextNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const fields = (data as { fields?: { text?: string } }).fields ?? {};
  const text = fields.text ?? "";
  return (
    <div className={cn(nodeShellBase, "w-[440px]", selected ? "border-primary" : "border-border")}>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground"
      />
      <div className="mb-1 text-xs font-medium text-muted-foreground">Text</div>
      <textarea
        className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        rows={9}
        placeholder="Type anything…"
        value={text}
        // ponytail: functional form — see GenerateNode comment. Even
        // though Text only has one field today, doing it the same
        // way as GenerateNode means a future sibling field won't get
        // wiped by a text edit. Cast `node.data.fields` to a record
        // because xyflow's generic NodeType widens `data` to unknown
        // and oxlint's type-aware check rejects spreading `unknown`.
        onChange={(e) =>
          updateNodeData(id, (node) => ({
            fields: {
              ...(node.data as { fields?: Record<string, unknown> }).fields,
              text: e.target.value,
            },
          }))
        }
      />
    </div>
  );
}

// ponytail: every node has BOTH a target (input, top) and a source
// (output, bottom) handle. Edges wire output→input — the same
// uniform data-flow model regardless of node type. Preview keeps
// its semantic meaning but can still participate in arbitrary
// graphs (Preview can fan out to multiple downstream nodes).
// Render is identical to before for the half of the data flow we
// use; the other half is just exposed.

function GenerateNode({ id, data, selected }: NodeProps) {
  const { updateNodeData, getNode, getEdges } = useReactFlow();
  const aui = useAui();
  const { setSourceNode } = useCanvas();
  const fields =
    (data as { fields?: { text?: string; aspectRatio?: string; num?: number } }).fields ?? {};
  const text = fields.text ?? "";
  const aspectRatio = fields.aspectRatio ?? "1:1";
  const num = fields.num ?? 1;
  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // ponytail: surface this node's id + position to the canvas
    // bridge so the generate_image tool UI card can wire a system
    // edge AND drop the Preview below the source node. The Send →
    // tool-call → card render is async (LLM in the middle), so we
    // capture now and the card reads it on mount.
    const node = getNode(id);
    if (node) {
      setSourceNode({
        id,
        position: { x: node.position.x, y: node.position.y },
        width: node.measured?.width ?? node.width,
        height: node.measured?.height ?? node.height,
      });
    }
    // ponytail: walk upstream edges → any connected Text or Preview
    // source node rides along in the user message. Text refs become
    // clickable chips (their label carries the first line); Preview
    // refs become image content parts so the LLM can actually SEE the
    // reference image (image-to-image flows). Without the image part
    // the LLM would only see the label "Image" with no visual
    // context — useless for "use this picture as a style reference".
    const upstreamSources = getEdges()
      .filter((e) => e.target === id)
      .map((e) => getNode(e.source))
      .filter(
        (n): n is NonNullable<typeof n> =>
          n !== null && n !== undefined && (n.type === "text" || n.type === "preview"),
      );
    // ponytail: short label is the first line, truncated to 30 chars.
    // Two upstream Text nodes with the same first line would collide —
    // unlikely in practice and the LLM only sees the content anyway.
    const labelFor = (content: string): string => {
      const firstLine = content.split("\n")[0]!.trim();
      if (firstLine.length === 0) return "Text";
      return firstLine.length <= 30 ? firstLine : `${firstLine.slice(0, 30)}…`;
    };
    const textRefs = upstreamSources
      .filter((n) => n.type === "text")
      .map((n) => {
        const text = ((n.data as { fields?: { text?: string } }).fields?.text ?? "").trim();
        return text.length > 0
          ? `:${CANVAS_DIRECTIVE_TEXT}[${labelFor(text)}]{nodeId=${n.id}}`
          : null;
      })
      .filter((s): s is string => s !== null)
      .join("\n");
    // ponytail: each upstream Preview becomes an image content part.
    // The runtime renders `{type:"image", image}` as an attachment
    // tile AND passes the URL to the LLM as a vision-capable input —
    // exactly the same path as a user-attached screenshot, so the
    // model receives the bytes without us needing to special-case
    // image-to-image in the tool schema. filename is stable per node
    // so re-sends don't churn.
    const imageParts = upstreamSources
      .filter((n) => n.type === "preview")
      .map((n) => {
        const url = (n.data as { fields?: { url?: string } }).fields?.url;
        if (!url) return null;
        return {
          type: "image" as const,
          image: url,
          filename: `canvas-image-${n.id.slice(0, 8)}.png`,
        };
      })
      .filter((p): p is { type: "image"; image: string; filename: string } => p !== null);
    // ponytail: Generate self-ref uses the prompt text as the chip's
    // label, with the aspect/num params appended inline as
    // `<prompt> 1:1 x2`. The chip IS the reference — no body line
    // afterwards to avoid echoing the chip text. Truncate the prompt
    // to keep the label readable; reserve ~10 chars for the params
    // suffix so the visible chip stays compact.
    const paramsSuffix = ` ${aspectRatio} x${num}`;
    const promptBudget = Math.max(8, 30 - paramsSuffix.length);
    const promptText =
      trimmed.length <= promptBudget ? trimmed : `${trimmed.slice(0, promptBudget)}…`;
    const generateRef = `:${CANVAS_DIRECTIVE_GENERATE_IMAGE}[${promptText}${paramsSuffix}]{nodeId=${id}}`;
    const header = [textRefs, generateRef].filter((s) => s.length > 0).join("\n");
    // ponytail: image parts go FIRST so the LLM sees the visual
    // reference before the prompt. The runtime renders them as
    // attachment tiles in the bubble AND forwards them as vision-
    // capable inputs to the model — same path as a user-attached
    // screenshot, no special-case in the tool schema.
    const content: Array<
      { type: "text"; text: string } | { type: "image"; image: string; filename: string }
    > = [];
    for (const part of imageParts) content.push(part);
    if (header.length > 0) content.push({ type: "text", text: header });
    aui.thread().append({
      role: "user",
      content,
    });
  };
  return (
    <div className={cn(nodeShellBase, selected ? "border-primary" : "border-border")}>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground"
      />
      <div className="mb-1 text-xs font-medium text-muted-foreground">Generate image</div>
      <textarea
        className="mb-2 w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        rows={3}
        placeholder="Describe the image…"
        value={text}
        // ponytail: xyflow's `updateNodeData` only shallow-merges the
        // top-level `data` object — passing `{ fields: { text } }`
        // REPLACES `data.fields` and wipes the other siblings. Use the
        // functional form so we spread the existing fields first.
        // Cast `node.data.fields` to a record because xyflow's generic
        // NodeType widens `data` to unknown and oxlint's type-aware
        // check rejects spreading `unknown`.
        onChange={(e) =>
          updateNodeData(id, (node) => ({
            fields: {
              ...(node.data as { fields?: Record<string, unknown> }).fields,
              text: e.target.value,
            },
          }))
        }
      />
      <div className="mb-2 grid grid-cols-2 gap-2">
        <label className="block text-xs">
          <span className="text-muted-foreground">Aspect</span>
          <select
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
            value={aspectRatio}
            onChange={(e) =>
              updateNodeData(id, (node) => ({
                fields: {
                  ...(node.data as { fields?: Record<string, unknown> }).fields,
                  aspectRatio: e.target.value,
                },
              }))
            }
          >
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
          </select>
        </label>
        <label className="block text-xs">
          <span className="text-muted-foreground">Variants</span>
          <select
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
            value={num}
            onChange={(e) =>
              updateNodeData(id, (node) => ({
                fields: {
                  ...(node.data as { fields?: Record<string, unknown> }).fields,
                  num: Number(e.target.value),
                },
              }))
            }
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        onClick={handleSend}
        disabled={!text.trim()}
      >
        Send
      </button>
    </div>
  );
}

function PreviewNode({ data, selected }: NodeProps) {
  const fields = (data as { fields?: { url?: string; w?: number; h?: number } }).fields ?? {};
  const url = fields.url;
  // ponytail: lock the image to its stored dims so the node doesn't
  // grow to the image's natural size. `maxWidth: 100%` lets it shrink
  // if the viewport narrows; without an explicit `width`/`height` the
  // image drives the container width and the half-size stored dims
  // become a suggestion, not a constraint. Default 256×256 covers
  // legacy hydrated nodes with no stored dims.
  const w = fields.w ?? 256;
  const h = fields.h ?? 256;
  return (
    <div className={cn(nodeShellBase, selected ? "border-primary" : "border-border")}>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground"
      />
      <div className="mb-1 text-xs font-medium text-muted-foreground">Image</div>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          width={w}
          height={h}
          style={{ width: w, height: h, maxWidth: "100%" }}
          className="block rounded border border-border"
        />
      ) : (
        <div
          style={{ width: w, height: h, maxWidth: "100%" }}
          className="flex items-center justify-center rounded border border-dashed border-border bg-muted/30 text-xs text-muted-foreground"
        >
          waiting for image…
        </div>
      )}
    </div>
  );
}

const nodeTypes = { text: TextNode, generate: GenerateNode, preview: PreviewNode };

function CanvasEditorInner({ threadId }: { threadId: string }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [ready, setReady] = useState(false);
  // ponytail: gates FitOnMount to fire ONLY when hydration produced
  // server-side nodes. The earlier `{ready && nodes.length > 0}`
  // gate had a bug: when the canvas was empty at hydrate time and the
  // user then dblclicked to drop the first node, FitOnMount re-rendered
  // with `enabled=true` and forced the viewport to recenter around
  // that one node — making the click land at viewport center instead
  // of where the cursor pointed. Loading from an empty server doc now
  // flips `loadedFromServer` to true WITHOUT triggering FitOnMount
  // (`onAfterLoad` early-returns on empty nodes), so the viewport
  // stays wherever the user's cursor puts it.
  const [hydrated, setHydrated] = useState(false);
  const [loadedFromServer, setLoadedFromServer] = useState(false);
  const register = useCanvasRegister();
  const canvas = useCanvas();
  const rf = useReactFlow();

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // ponytail: register React state setters + auto-save schedule with
  // the canvas bridge. Mutations from tool-ui cards route through
  // these setters, so `onNodesChange` / `onEdgesChange` fire normally
  // and the debounced auto-save runs. `viewportCenter` lets cards
  // drop new nodes without importing React Flow. Unregister on unmount
  // so the bridge falls back to the noop API.
  useEffect(() => {
    register({
      setNodes,
      setEdges,
      schedule,
      viewportCenter: () => {
        const vp = rf.getViewport();
        const cw = typeof window !== "undefined" ? window.innerWidth : 800;
        const ch = typeof window !== "undefined" ? window.innerHeight : 600;
        return {
          x: (-vp.x + cw / 2) / vp.zoom,
          y: (-vp.y + ch / 2) / vp.zoom,
        };
      },
      focusNode: (nodeId: string) => {
        // ponytail: center the viewport on the node AND select it so
        // the user's eye lands on the node, not just the empty canvas
        // around it. We route through `rf.setNodes` (xyflow's internal
        // store) instead of our React useState setter so the selection
        // change fires `onNodesChange` and stays consistent with every
        // other selection flip on the canvas.
        const node = rf.getNode(nodeId);
        if (!node) return;
        rf.setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })));
        const w = node.measured?.width ?? node.width ?? 220;
        const h = node.measured?.height ?? node.height ?? 100;
        rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
          zoom: 1,
          duration: 400,
        });
      },
    });
    return () => {
      register(null);
    };
    // ponyint: schedule / rf / setNodes / setEdges are all stable;
    // re-registering would force-render the provider tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ponytail: hydrate from server. parseCanvasDocument returns the
  // empty document on a 404 / parse failure — the first save
  // creates the row. We seed both `nodes` and `edges` in one setState
  // pair so React Flow sees a consistent initial frame.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    // ponytail: placeholder threads (aUI's `__LOCAL_<rand>` stand-in
    // before the first server round-trip) aren't bound to a row in
    // the snapshots table — hitting /api/canvas/{placeholder} either
    // 404s the row lookup or creates a stray row no real thread ever
    // resumes. Skip the fetch; the canvas stays empty until the real
    // id lands and the effect re-runs.
    if (isPlaceholderThread(threadId)) {
      setHydrated(true);
      setReady(true);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`/api/canvas/${threadId}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { document: unknown };
          const doc = parseCanvasDocument(body.document);
          if (doc.nodes.length > 0 || doc.edges.length > 0) {
            setNodes(
              doc.nodes.map((n) => ({
                id: n.id,
                position: n.position,
                type: n.data.type,
                data: { type: n.data.type, fields: n.data.fields },
              })) as Node[],
            );
            setEdges(
              doc.edges.map((e) => ({
                id: e.id,
                source: e.source,
                target: e.target,
                // ponytail: restore `data.system` from persistence so
                // the lock survives page reloads. Without this, the
                // user could disconnect Generate from Preview after
                // a refresh — defeating the locked-edge invariant.
                data: e.data?.system === true ? { system: true } : undefined,
                sourceHandle: e.sourceHandle ?? undefined,
                targetHandle: e.targetHandle ?? undefined,
              })) as Edge[],
            );
          }
        }
      } catch (err) {
        console.error("CanvasEditor: failed to hydrate snapshot", err);
      } finally {
        if (!cancelled) {
          setHydrated(true);
          setReady(true);
          // ponytail: flip loadedFromServer regardless of whether the
          // doc had nodes — see state declaration above. Empty doc
          // skips the fitView (onAfterLoad early-returns on empty),
          // populated doc recenters viewport around the loaded nodes.
          setLoadedFromServer(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const getDocumentAction = useCallback(
    () => toCanvasDocument(nodesRef.current, edgesRef.current),
    [],
  );
  const { schedule } = useCanvasAutoSave({ threadId, getDocumentAction, enabled: true });

  // ponytail: apply user-driven node changes; reject any change that
  // would remove a system edge (the only edges with `data.system`).
  const onNodesChange: OnNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      schedule();
    },
    [schedule],
  );
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const filtered = changes.filter((c) => {
        if (c.type === "remove") {
          const edge = edgesRef.current.find((e) => e.id === c.id);
          if (edge?.data && (edge.data as { system?: boolean }).system) return false;
        }
        return true;
      });
      if (filtered.length === 0) return;
      setEdges((eds) => applyEdgeChanges(filtered, eds));
      schedule();
    },
    [schedule],
  );

  // ponytail: fit the camera to the content after a snapshot loads,
  // then dial zoom back to 1.0 (user: "zoom 100%, position to all
  // elements center"). Default zoomToFit is too tight; the simpler
  // ask is "centered, zoom 1" — that is what we implement. The
  // once-only guarantee lives in FitOnMount's own ref so the parent
  // doesn't have to know.
  const onAfterLoad = useCallback(() => {
    const eds = nodesRef.current;
    if (eds.length === 0) return;
    const minX = Math.min(...eds.map((n) => n.position.x));
    const minY = Math.min(...eds.map((n) => n.position.y));
    const maxX = Math.max(...eds.map((n) => n.position.x + 260));
    const maxY = Math.max(...eds.map((n) => n.position.y + 160));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    rf.setViewport({ x: window.innerWidth / 2 - cx, y: window.innerHeight / 2 - cy, zoom: 1 });
  }, [rf]);

  // ponytail: double-click an empty pane (or drop a handle on empty
  // space) → show the same picker menu (Generate / Preview).
  // We stash the screen position (menu anchor), the flow position
  // (where the new node lands), and — when invoked from a drag —
  // the source node + handle so pickKind can wire the edge.
  const [picker, setPicker] = useState<{
    x: number;
    y: number;
    flow: { x: number; y: number };
    fromNodeId?: string;
    fromHandleId?: string | null;
  } | null>(null);
  // ponytail: React Flow positions nodes by top-left, so the cursor
  // anchors the node's TOP-LEFT corner directly — no centering offset.
  // The user clicks where they want the node's corner; the node grows
  // down-right from there.
  const onWrapperDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(".react-flow__node")) return;
      const flow = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setPicker({
        x: event.clientX,
        y: event.clientY,
        flow,
      });
    },
    [rf],
  );

  // ponytail: dismiss the picker on Esc or on a click outside the
  // menu. We listen on the document (the menu is a fixed-position
  // div, not a child of the dblclick target) and bail when the click
  // is inside `.canvas-picker` so menu clicks don't self-dismiss.
  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".canvas-picker")) return;
      setPicker(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [picker]);

  const pickKind = useCallback(
    // ponytail: Preview is intentionally NOT a picker option. It only
    // appears after a `generate_image` tool call returns — the tool
    // card's "Add to canvas" button calls `canvas.insertImage()` to
    // drop it. Letting users hand-place Preview nodes invites empty
    // placeholders with no upstream Generate and no image to render.
    (kind: "text" | "generate") => {
      if (!picker) return;
      const newId = canvas.addNode({ type: kind, position: picker.flow });
      // ponytail: if the picker was opened from a handle-drag, also
      // wire an edge from the source handle to the new node's top.
      if (newId && picker.fromNodeId) {
        canvas.addEdge({
          source: picker.fromNodeId,
          target: newId,
          sourceHandle: picker.fromHandleId ?? null,
          targetHandle: null,
        });
      }
      setPicker(null);
    },
    [canvas, picker],
  );

  // ponytail: dragging from a handle onto empty space should grow the
  // graph at the drop point — drop a new Generate node and wire the
  // source handle to its top. We bail when the user lands on a real
  // target handle (React Flow's default onConnect handles that case)
  // or when there's no source node (no-op drag). xyflow's
  // `connectionState.toPosition` is a HANDLE ENUM, not cursor coords,
  // so we read clientX/Y off the raw event instead.
  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      if (!connectionState.fromNode) return;
      if (connectionState.toHandle) return;
      const ev = event as MouseEvent;
      const touch = (event as TouchEvent).changedTouches?.[0];
      const cx = ev.clientX ?? touch?.clientX ?? 0;
      const cy = ev.clientY ?? touch?.clientY ?? 0;
      const flow = rf.screenToFlowPosition({ x: cx, y: cy });
      // ponytail: show the same picker the dblclick uses — user
      // picks Generate. We stash the source handle + node so
      // pickKind wires the edge when the user makes a choice.
      // Top-left anchoring matches the dblclick handler — the
      // cursor lands on the new node's top-left.
      setPicker({
        x: cx,
        y: cy,
        flow,
        fromNodeId: connectionState.fromNode.id,
        fromHandleId: connectionState.fromHandle?.id ?? null,
      });
    },
    [rf],
  );

  // ponytail: handle→handle connection completes here. xyflow's default
  // `onConnect` would mutate internal state and bypass our `edges`
  // controlled prop, which would skip `onEdgesChange` and miss the
  // auto-save. We route through `canvas.addEdge` instead so the edge
  // enters via setEdges (same source of truth as the picker path).
  const onConnect = useCallback(
    (connection: {
      source: string | null;
      target: string | null;
      sourceHandle?: string | null;
      targetHandle?: string | null;
    }) => {
      if (!connection.source || !connection.target) return;
      canvas.addEdge({
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? null,
        targetHandle: connection.targetHandle ?? null,
      });
    },
    [canvas],
  );

  const defaultEdgeOptions = useMemo(() => ({ animated: false }), []);

  return (
    <div className="relative h-full w-full overflow-hidden" onDoubleClick={onWrapperDoubleClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView={false}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
        nodesDraggable
        nodesConnectable
        edgesFocusable={false}
        zoomOnDoubleClick={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          className="!bg-card"
          position="bottom-left"
          style={{ marginLeft: 60 }}
        />
      </ReactFlow>

      {!ready && (
        <div className="bg-background/60 pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading canvas…
        </div>
      )}

      {/* Mount FitOnMount exactly once — right after hydration finishes
          (`hydrated` flips true the same tick `ready` does). Its own
          ref guards re-firing; subsequent node adds don't remount it,
          so the ref survives. The `enabled` prop is a no-op gate for
          empty docs (hydration with 0 nodes — nothing to fit). */}
      {ready && hydrated && <FitOnMount enabled={loadedFromServer} onAfter={onAfterLoad} />}

      {/* ponytail: entry-only animation. The wrapper unmounts when
          `picker` flips null — no phantom div sitting at the last
          position to be re-triggered on the next dblclick. tw-animate-css
          handles the fade+zoom-in via `animate-in fade-in zoom-in-95`. */}
      {picker && (
        <div
          // ponytail: double-click picker. fixed at the cursor, offset
          // by a few px so it doesn't sit under the pointer and steal
          // the click. `canvas-picker` class is the dismiss-bailout
          // marker for the document mousedown listener above.
          className="canvas-picker fixed z-50 flex animate-in fade-in zoom-in-95 flex-col gap-1 rounded-md border border-border/60 bg-card p-1 shadow-md duration-150"
          style={{ left: picker.x + 8, top: picker.y + 8 }}
        >
          <PickerButton
            label="Text"
            icon={<TypeIcon className="size-3.5" />}
            onClick={() => pickKind("text")}
          />
          <PickerButton
            label="Generate image"
            icon={<ImageIcon className="size-3.5" />}
            onClick={() => pickKind("generate")}
          />
        </div>
      )}
    </div>
  );
}

function PickerButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded px-3 py-1 text-left text-xs hover:bg-muted"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ponytail: render-once effect that fires the centering once after
// the `ready` / `nodes.length` flip. Lives under a separate component
// so the parent's render doesn't keep re-triggering on each node change.
function FitOnMount({ enabled, onAfter }: { enabled: boolean; onAfter: () => void }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    if (!enabled) return;
    fired.current = true;
    onAfter();
  }, [enabled, onAfter]);
  return null;
}

// ponytail: wrap in ReactFlowProvider so any descendant node component
// can call `useReactFlow()` (GenerateNode uses it for `updateNodeData`).
// The parent layout dynamically imports us with ssr: false; the
// provider ensures the internal store is ready
// before we render.
export function CanvasEditor(props: { threadId: string }) {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner {...props} />
    </ReactFlowProvider>
  );
}
