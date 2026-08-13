import { z } from "zod";

// ponytail: minimal JSON schema for what's persisted. The full
// React Flow state includes viewport transform, dimensions, and
// selection — none of which belong on disk. The persistence path
// is `nodes + edges`; load rebuilds React Flow state from these two
// arrays plus a default viewport. We type `data` as a free record
// (each node type's React component validates on render).
export const CanvasNodeData = z.object({
  // node type — discriminator for the React Flow custom node renderer.
  type: z.enum(["prompt", "generate", "preview"]),
  // node-type-specific fields. Free record; the renderer reads what
  // it needs. For "prompt" the field is { text }. For "generate" the
  // fields are { aspectRatio }. For "preview" the field is { url? }.
  // We accept any object so adding a new node type doesn't require
  // touching this schema.
  fields: z.record(z.string(), z.unknown()).default({}),
});

export const CanvasNode = z.object({
  id: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  data: CanvasNodeData,
});

export const CanvasEdge = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  // "system" edges are drawn by the agent when a tool returns a
  // result bound to a target node; the canvas refuses to delete
  // them (the React Flow onEdgesDelete handler short-circuits).
  // Persisted so reloads preserve the lock — otherwise a fresh
  // page load would let the user delete them.
  data: z
    .object({
      system: z.boolean().optional(),
    })
    .optional(),
  sourceHandle: z.string().nullish(),
  targetHandle: z.string().nullish(),
});

export const CanvasDocumentBody = z.object({
  nodes: z.array(CanvasNode).default([]),
  edges: z.array(CanvasEdge).default([]),
});

export type CanvasNodeDataT = z.infer<typeof CanvasNodeData>;
export type CanvasNodeT = z.infer<typeof CanvasNode>;
export type CanvasEdgeT = z.infer<typeof CanvasEdge>;
export type CanvasDocumentT = z.infer<typeof CanvasDocumentBody>;
