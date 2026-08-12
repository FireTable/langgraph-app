import { TLShapeId, VecModel } from "tldraw";
import { EditorAtom } from "./utils";
import type { NodeType } from "./nodes/nodeTypes";

/**
 * Stub for the original starter's OnCanvasNodePicker state atom.
 *
 * In the original starter, double-clicking a connection opens an on-canvas
 * picker that lets the user drop a node in the middle of a connection.
 * In our integration the AGENT places nodes (not the user), so we don't
 * render the picker UI — but the state atom still has to exist so the
 * connection / pointing-port side effects can call `.set(editor, ...)`
 * without crashing. They'll never be read because nothing opens the
 * picker.
 */
export interface OnCanvasNodePickerState {
  connectionShapeId: TLShapeId;
  location: "start" | "end" | "middle";
  onPick: (nodeType: NodeType, position: VecModel) => void;
  onClose: () => void;
}

export const onCanvasNodePickerState = new EditorAtom<OnCanvasNodePickerState | null>(
  "on canvas node picker",
  () => null,
);
