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
  type OnNodesChange,
  type OnEdgesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useCanvasAutoSave, toCanvasDocument } from "@/lib/canvas/auto-save";
import { useCanvas, useCanvasRegister } from "@/lib/canvas/context";
import { parseCanvasDocument } from "@/lib/canvas/snapshot";
import { useAui } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

// ponytail: every node-type-specific custom node reads its data via
// `data.fields` and writes back through `useReactFlow().updateNodeData`.
// Handles stay explicit (top source, bottom target) so future drag-to-
// connect wiring still has anchor points; right now `onConnect` is unset
// — the agent's generate_image UI card is the only thing that calls
// `addEdge`, and it sets `data.system = true` so deletion is locked.

type NodeKind = "prompt" | "generate" | "preview";

const nodeShellBase =
  "min-w-[220px] rounded-lg border bg-card p-3 text-sm shadow-sm transition-colors";

function PromptNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const fields = (data as { fields?: { text?: string } }).fields ?? {};
  const text = fields.text ?? "";
  return (
    <div className={cn(nodeShellBase, selected ? "border-primary" : "border-border")}>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
      <div className="mb-1 text-xs font-medium text-muted-foreground">Prompt</div>
      <textarea
        className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        rows={3}
        placeholder="Describe the image…"
        value={text}
        onChange={(e) => updateNodeData(id, { fields: { text: e.target.value } })}
      />
    </div>
  );
}

function GenerateNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const aui = useAui();
  const { setSourceNodeId } = useCanvas();
  const fields = (data as { fields?: { aspectRatio?: string } }).fields ?? {};
  const aspectRatio = fields.aspectRatio ?? "1:1";
  return (
    <div className={cn(nodeShellBase, selected ? "border-primary" : "border-border")}>
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
      <div className="mb-1 text-xs font-medium text-muted-foreground">Generate</div>
      <label className="mb-2 block text-xs">
        <span className="text-muted-foreground">Aspect ratio</span>
        <select
          className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
          value={aspectRatio}
          onChange={(e) => updateNodeData(id, { fields: { aspectRatio: e.target.value } })}
        >
          <option value="1:1">1:1</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
        </select>
      </label>
      <button
        type="button"
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
        onClick={() => {
          // ponytail: surface this node's id to the canvas bridge so
          // the generate_image tool UI card can wire a system edge
          // from this node to the new Preview node when the tool
          // returns. The Send → tool-call → card render is async
          // (LLM in the middle), so we capture now and the card
          // reads it on mount.
          const text = collectPromptText();
          if (!text) return;
          setSourceNodeId(id);
          aui.thread().append({
            role: "user",
            content: [{ type: "text", text }],
          });
        }}
      >
        Send
      </button>
    </div>
  );
}

function PreviewNode({ data, selected }: NodeProps) {
  const fields = (data as { fields?: { url?: string } }).fields ?? {};
  const url = fields.url;
  return (
    <div className={cn(nodeShellBase, selected ? "border-primary" : "border-border")}>
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <div className="mb-1 text-xs font-medium text-muted-foreground">Preview</div>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="max-w-full rounded border border-border" />
      ) : (
        <div className="rounded border border-dashed border-border bg-muted/30 px-2 py-6 text-center text-xs text-muted-foreground">
          waiting for image…
        </div>
      )}
    </div>
  );
}

const nodeTypes = { prompt: PromptNode, generate: GenerateNode, preview: PreviewNode };

// ponytail: pull the upstream Prompt node's text by walking the
// current edges. We capture this at click-time so the React Flow
// state is fresh. Lives at module scope so both GenerateNode and
// the canvas can call it — the canvas installs an instance ref
// via the register hook the GenerateNode reads.
let _collectPromptTextImpl: () => string = () => "";
function collectPromptText(): string {
  return _collectPromptTextImpl();
}

function CanvasEditorInner({ threadId }: { threadId: string }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [ready, setReady] = useState(false);
  const register = useCanvasRegister();
  const canvas = useCanvas();
  const rf = useReactFlow();

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // ponytail: expose the latest `nodes` to the GenerateNode click
  // handler so it can pull the upstream Prompt text at send-time.
  // `useCanvas()` doesn't need this — only the GenerateNode does.
  useEffect(() => {
    _collectPromptTextImpl = () => {
      const nds = nodesRef.current;
      const prompt = nds.find((n) => n.type === "prompt");
      if (!prompt) return "";
      const promptText = (prompt.data as { fields?: { text?: string } }).fields?.text ?? "";
      return promptText;
    };
  }, []);

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
    });
    return () => {
      register(null);
      _collectPromptTextImpl = () => "";
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
        if (!cancelled) setReady(true);
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
  // ask is "centered, zoom 1" — that is what we implement.
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

  const handleAdd = useCallback(
    (type: NodeKind) => {
      canvas.addNode({ type });
    },
    [canvas],
  );

  const defaultEdgeOptions = useMemo(() => ({ animated: false }), []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView={false}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
        nodesDraggable
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-card" />
      </ReactFlow>

      {/*
        Toolbar. Fixed top-left, three buttons for the three node
        kinds. Calls `handleAdd` → `canvas.addNode` → instance
        `setNodes` (drop at viewport center).
      */}
      <div className="absolute left-3 top-3 z-10 flex gap-1 rounded-md border border-border/60 bg-card/80 p-1 shadow-sm backdrop-blur-md">
        <ToolbarButton label="+ Prompt" onClick={() => handleAdd("prompt")} />
        <ToolbarButton label="+ Generate" onClick={() => handleAdd("generate")} />
        <ToolbarButton label="+ Preview" onClick={() => handleAdd("preview")} />
      </div>

      {!ready && (
        <div className="bg-background/60 pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading canvas…
        </div>
      )}

      {/* run fitView once after a fresh load completes */}
      {ready && nodes.length > 0 && <FitOnMount onAfter={onAfterLoad} />}
    </div>
  );
}

// ponytail: render-once effect that fires the centering once after
// the `ready` / `nodes.length` flip. Lives under a separate component
// so the parent's render doesn't keep re-triggering on each node change.
function FitOnMount({ onAfter }: { onAfter: () => void }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    onAfter();
  }, [onAfter]);
  return null;
}

function ToolbarButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded px-2 py-1 text-xs hover:bg-muted">
      {label}
    </button>
  );
}

// ponytail: wrap in ReactFlowProvider so any descendant node component
// can call `useReactFlow()` (PromptNode / GenerateNode use it for
// `updateNodeData`). The parent layout dynamically imports us with
// ssr: false; the provider ensures the internal store is ready
// before we render.
export function CanvasEditor(props: { threadId: string }) {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner {...props} />
    </ReactFlowProvider>
  );
}
