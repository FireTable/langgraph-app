import { Editor, T, useEditor, WeakCache } from "tldraw";
import {
  NODE_FOOTER_HEIGHT_PX,
  NODE_HEADER_HEIGHT_PX,
  NODE_ROW_BOTTOM_PADDING_PX,
  NODE_ROW_HEADER_GAP_PX,
} from "../constants";
import { PortId, ShapePort } from "../ports/Port";
import { NodeShape } from "./NodeShapeUtil";
import { GenerateNodeDefinition } from "./types/GenerateNode";
import { PreviewNodeDefinition } from "./types/PreviewNode";
import { PromptNodeDefinition } from "./types/PromptNode";
import { InfoValues, NodeDefinition, NodeDefinitionConstructor } from "./types/shared";

/**
 * nodeTypes — registry for the canvas node editor.
 *
 * MVP scope: prompt / generate / preview. The agent places nodes via
 * `useCanvas().createNode({ type, props })`, the user fills the inputs,
 * and clicking "Run pipeline" serializes the graph into a LangGraph
 * user message (see docs/CANVAS_NODES.md).
 *
 * Excluded from the MVP (intentionally, see design doc): model, generate_text,
 * controlnet, load_image, blend, adjust, upscale, ip_adapter, style_transfer,
 * prompt_concat, number, router, iterator, capture. They live in the original
 * starter if we ever want them.
 */
export const NodeDefinitions = {
  prompt: PromptNodeDefinition,
  generate: GenerateNodeDefinition,
  preview: PreviewNodeDefinition,
} satisfies Record<string, NodeDefinitionConstructor<any>>;

/**
 * Union of all node prop shapes. tldraw's TypeOf extracts this from the
 * validator union below.
 */
export type NodeType = T.TypeOf<typeof NodeType>;
export const NodeType = T.union(
  "type",
  Object.fromEntries(Object.values(NodeDefinitions).map((type) => [type.type, type.validator])) as {
    [K in keyof typeof NodeDefinitions as (typeof NodeDefinitions)[K]["type"]]: (typeof NodeDefinitions)[K]["validator"];
  },
);

// ponytail: per-editor instances of every node definition. The editor
// parameter is used by node definitions to read editor-side state
// (snapping, current style, etc.) when rendering their body.
const nodeDefinitions = new WeakCache<
  Editor,
  { [K in keyof typeof NodeDefinitions]: InstanceType<(typeof NodeDefinitions)[K]> }
>();

export function getNodeDefinitions(editor: Editor) {
  return nodeDefinitions.get(editor, () => {
    return Object.fromEntries(
      Object.values(NodeDefinitions).map((value) => [value.type, new value(editor)]),
    ) as {
      [K in keyof typeof NodeDefinitions]: InstanceType<(typeof NodeDefinitions)[K]>;
    };
  });
}

export function getNodeDefinition(
  editor: Editor,
  node: NodeType | NodeType["type"],
): NodeDefinition<any> {
  return getNodeDefinitions(editor)[
    typeof node === "string" ? node : node.type
  ] as NodeDefinition<any>;
}

export function getNodeWidthPx(editor: Editor, shape: NodeShape): number {
  return getNodeDefinition(editor, shape.props.node).getWidthPx(shape, shape.props.node);
}

export function getNodeBodyHeightPx(editor: Editor, shape: NodeShape): number {
  return getNodeDefinition(editor, shape.props.node).getBodyHeightPx(shape, shape.props.node);
}

export function getNodeHeightPx(editor: Editor, shape: NodeShape): number {
  return (
    NODE_HEADER_HEIGHT_PX +
    NODE_ROW_HEADER_GAP_PX +
    getNodeBodyHeightPx(editor, shape) +
    NODE_ROW_BOTTOM_PADDING_PX +
    NODE_FOOTER_HEIGHT_PX
  );
}

export function getNodeTypePorts(editor: Editor, shape: NodeShape): Record<PortId, ShapePort> {
  return getNodeDefinition(editor, shape.props.node).getPorts(shape, shape.props.node);
}

export function getNodeOutputInfo(
  editor: Editor,
  shape: NodeShape,
  inputs: InfoValues,
): InfoValues {
  return getNodeDefinition(editor, shape.props.node).getOutputInfo(shape, shape.props.node, inputs);
}

export function getPortDataType(
  editor: Editor,
  shapeId: NodeShape["id"] | NodeShape,
  portId: PortId,
): ShapePort["dataType"] | null {
  const shape = typeof shapeId === "string" ? editor.getShape<NodeShape>(shapeId) : shapeId;
  if (!shape) return null;
  const ports = getNodeTypePorts(editor, shape);
  return ports[portId]?.dataType ?? null;
}

export function onNodePortDisconnect(editor: Editor, shape: NodeShape, port: PortId) {
  getNodeDefinition(editor, shape.props.node).onPortDisconnect?.(shape, shape.props.node, port);
}

export function onNodePortConnect(editor: Editor, shape: NodeShape, port: PortId) {
  getNodeDefinition(editor, shape.props.node).onPortConnect?.(shape, shape.props.node, port);
}

// ponytail: dispatch the right Component for the shape's node type. The
// shape's props.node is the typed node data; we look up the definition
// and render its Component. The node's own component (e.g.
// PromptNodeComponent) handles filling-in.
export function NodeBody({ shape }: { shape: NodeShape }) {
  const editor = useEditor();
  const node = shape.props.node;
  const { Component } = getNodeDefinition(editor, node);
  return <Component shape={shape} node={node} />;
}
