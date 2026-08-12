import { T, useEditor, useValue } from "tldraw";
import { PreviewIcon } from "../../icons/PreviewIcon";
import {
  NODE_HEADER_HEIGHT_PX,
  NODE_IMAGE_PREVIEW_HEIGHT_PX,
  NODE_ROW_HEIGHT_PX,
  NODE_WIDTH_PX,
} from "../../constants";
import { Port, ShapePort } from "../../ports/Port";
import { getNodeInputPortValues } from "../nodePorts";
import { NodeShape } from "../NodeShapeUtil";
import {
  areAnyInputsOutOfDate,
  InfoValues,
  InputValues,
  NodeComponentProps,
  NodeDefinition,
  NodeImage,
  NodeRow,
  updateNode,
} from "./shared";

export type PreviewNode = T.TypeOf<typeof PreviewNode>;
export const PreviewNode = T.object({
  type: T.literal("preview"),
  caption: T.string,
});

export class PreviewNodeDefinition extends NodeDefinition<PreviewNode> {
  static type = "preview";
  static validator = PreviewNode;
  title = "Preview";
  heading = "Preview";
  icon = <PreviewIcon />;
  category = "output";
  getDefault(): PreviewNode {
    return { type: "preview", caption: "" };
  }
  getBodyHeightPx() {
    // 1 input port + image preview + 1 caption row
    return NODE_ROW_HEIGHT_PX * 2 + NODE_IMAGE_PREVIEW_HEIGHT_PX;
  }
  getPorts(_shape: NodeShape, _node: PreviewNode): Record<string, ShapePort> {
    const baseY = NODE_HEADER_HEIGHT_PX + 8;
    return {
      image: {
        id: "image",
        x: 0,
        y: baseY + NODE_ROW_HEIGHT_PX * 0.5,
        terminal: "end",
        dataType: "image",
      },
      text: {
        id: "text",
        x: 0,
        y: baseY + NODE_ROW_HEIGHT_PX * 1.5,
        terminal: "end",
        dataType: "text",
      },
    };
  }
  // ponytail: Preview is a sink. The agent places it at the end of a
  // pipeline; the image flows in via the binding system. No execute()
  // body — the node just renders whatever the upstream image source
  // produced.
  async execute(
    _shape: NodeShape,
    _node: PreviewNode,
    _inputs: InputValues,
  ): Promise<Record<string, never>> {
    return {};
  }
  getOutputInfo(_shape: NodeShape, _node: PreviewNode, _inputs: InfoValues): InfoValues {
    return {};
  }
  Component = PreviewNodeComponent;
}

function PreviewNodeComponent({ shape, node }: NodeComponentProps<PreviewNode>) {
  const editor = useEditor();

  const imageInput = useValue("image input", () => getNodeInputPortValues(editor, shape.id).image, [
    editor,
    shape.id,
  ]);

  const imageUrl =
    imageInput && !imageInput.isOutOfDate && typeof imageInput.value === "string"
      ? imageInput.value
      : null;

  return (
    <>
      <NodeRow>
        <Port shapeId={shape.id} portId="image" />
        <span className="NodePortLabel">Image</span>
        {imageInput ? (
          <span className="NodeRow-connected-value">
            {imageInput.isOutOfDate ? "stale" : "connected"}
          </span>
        ) : (
          <span className="NodeRow-disconnected">not connected</span>
        )}
      </NodeRow>
      <NodeRow>
        <Port shapeId={shape.id} portId="text" />
        <span className="NodePortLabel">Caption</span>
        <input
          type="text"
          value={node.caption}
          placeholder="optional caption"
          onChange={(e) =>
            updateNode<PreviewNode>(
              editor,
              shape,
              (n) => ({ ...n, caption: e.target.value }),
              false,
            )
          }
          onPointerDown={(e) => e.stopPropagation()}
          onFocus={() => editor.setSelectedShapes([shape.id])}
        />
      </NodeRow>
      <div className="NodeImagePreview">
        {imageUrl ? (
          <NodeImage src={imageUrl} alt={node.caption || "Preview"} />
        ) : (
          <div className="NodeImagePreview-empty">
            <span>Connect to an image source</span>
          </div>
        )}
      </div>
    </>
  );
}
