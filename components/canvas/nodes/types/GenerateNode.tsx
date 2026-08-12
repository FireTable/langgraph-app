import classNames from "classnames";
import { T, useEditor, useValue } from "tldraw";
import { GenerateIcon } from "../../icons/GenerateIcon";
import {
  NODE_HEADER_HEIGHT_PX,
  NODE_IMAGE_PREVIEW_HEIGHT_PX,
  NODE_ROW_HEADER_GAP_PX,
  NODE_ROW_HEIGHT_PX,
  NODE_WIDTH_PX,
} from "../../constants";
import { Port, ShapePort } from "../../ports/Port";
import { getNodeInputPortValues } from "../nodePorts";
import { NodeShape } from "../NodeShapeUtil";
import {
  areAnyInputsOutOfDate,
  ExecutionResult,
  InfoValues,
  InputValues,
  isMultiInfoValue,
  NodeComponentProps,
  NodeDefinition,
  NodeImage,
  NodePlaceholder,
  NodePortLabel,
  NodeRow,
  STOP_EXECUTION,
  updateNode,
} from "./shared";

const ASPECT_RATIOS = ["square", "portrait", "landscape"] as const;
type AspectRatio = (typeof ASPECT_RATIOS)[number];

// ponytail: aspectRatio is a runtime-validated string. tldraw's T.literal
// only accepts a single value — no splice — so we keep it as T.string and
// narrow at the call site (the Component reads node.aspectRatio and the
// <select> only emits the three valid values).
export type GenerateNode = T.TypeOf<typeof GenerateNode>;
export const GenerateNode = T.object({
  type: T.literal("generate"),
  aspectRatio: T.string,
  lastResultUrl: T.string.nullable(),
  isMock: T.boolean,
});

export class GenerateNodeDefinition extends NodeDefinition<GenerateNode> {
  static type = "generate";
  static validator = GenerateNode;
  title = "Generate";
  heading = "Generate";
  icon = <GenerateIcon />;
  category = "process";
  resultKeys = ["lastResultUrl"] as const;
  getDefault(): GenerateNode {
    return {
      type: "generate",
      aspectRatio: "square" as AspectRatio,
      lastResultUrl: null,
      isMock: false,
    };
  }
  getBodyHeightPx() {
    // 2 port rows (prompt, ref image) + image preview + 1 parameter row (aspect_ratio)
    return NODE_ROW_HEIGHT_PX * 3 + NODE_IMAGE_PREVIEW_HEIGHT_PX;
  }
  getPorts(_shape: NodeShape, _node: GenerateNode): Record<string, ShapePort> {
    const baseY = NODE_HEADER_HEIGHT_PX + NODE_ROW_HEADER_GAP_PX;
    return {
      prompt: {
        id: "prompt",
        x: 0,
        y: baseY + NODE_ROW_HEIGHT_PX * 0.5,
        terminal: "end",
        dataType: "text",
        multi: true,
      },
      image: {
        id: "image",
        x: 0,
        y: baseY + NODE_ROW_HEIGHT_PX * 1.5,
        terminal: "end",
        dataType: "image",
      },
      output: {
        id: "output",
        x: NODE_WIDTH_PX,
        y: NODE_HEADER_HEIGHT_PX / 2,
        terminal: "start",
        dataType: "image",
      },
    };
  }
  // ponytail: pass-through execute. The agent orchestrates the real
  // generate_image call (via the LangGraph tool). The canvas node just
  // surfaces the resolved input + aspect_ratio so the agent can call
  // the tool with the right params. lastResultUrl is written back by the
  // generate_image tool UI card via CanvasProvider.setNodeResult().
  async execute(
    shape: NodeShape,
    _node: GenerateNode,
    inputs: InputValues,
  ): Promise<ExecutionResult> {
    const rawPrompt = inputs.prompt;
    const promptValues = Array.isArray(rawPrompt) ? rawPrompt : [rawPrompt];
    const prompt = promptValues
      .filter((v): v is string => typeof v === "string" && v !== "")
      .join(", ");
    return { output: null, _prompt: prompt };
  }
  getOutputInfo(shape: NodeShape, node: GenerateNode, inputs: InfoValues): InfoValues {
    return {
      output: {
        value: node.lastResultUrl,
        isOutOfDate: areAnyInputsOutOfDate(inputs) || shape.props.isOutOfDate,
        dataType: "image",
      },
    };
  }
  Component = GenerateNodeComponent;
}

function GenerateNodeComponent({ shape, node }: NodeComponentProps<GenerateNode>) {
  const editor = useEditor();

  const promptInput = useValue(
    "prompt input",
    () => getNodeInputPortValues(editor, shape.id).prompt,
    [editor, shape.id],
  );
  const imageInput = useValue("image input", () => getNodeInputPortValues(editor, shape.id).image, [
    editor,
    shape.id,
  ]);

  return (
    <>
      <NodeRow>
        <Port shapeId={shape.id} portId="prompt" />
        <NodePortLabel dataType="text">Prompt</NodePortLabel>
        {promptInput ? (
          <span className="NodeRow-connected-value">
            {promptInput.isOutOfDate ? (
              <NodePlaceholder />
            ) : (
              (() => {
                const display = isMultiInfoValue(promptInput)
                  ? promptInput.value.filter((v): v is string => typeof v === "string").join(", ")
                  : String(promptInput.value ?? "");
                return (
                  <span title={display}>
                    {display.slice(0, 20)}
                    {display.length > 20 ? "..." : ""}
                  </span>
                );
              })()
            )}
          </span>
        ) : (
          <span className="NodeRow-disconnected">not connected</span>
        )}
      </NodeRow>
      <NodeRow>
        <Port shapeId={shape.id} portId="image" />
        <NodePortLabel dataType="image">Ref image</NodePortLabel>
        {imageInput ? (
          <span className="NodeRow-connected-value">
            {imageInput.isOutOfDate ? <NodePlaceholder /> : "connected"}
          </span>
        ) : (
          <span className="NodeRow-disconnected">optional</span>
        )}
      </NodeRow>
      <div
        className={classNames("NodeImagePreview", {
          NodeImagePreview_loading: shape.props.isOutOfDate,
        })}
      >
        {node.lastResultUrl ? (
          <NodeImage src={node.lastResultUrl} alt="Generated" />
        ) : (
          <div className="NodeImagePreview-empty">
            <span>Run pipeline to generate</span>
          </div>
        )}
      </div>
      <NodeRow className="NodeInputRow">
        <span className="NodeInputRow-label">Aspect</span>
        <select
          value={node.aspectRatio}
          onChange={(e) =>
            updateNode<GenerateNode>(
              editor,
              shape,
              (n) => ({ ...n, aspectRatio: e.target.value as AspectRatio }),
              false,
            )
          }
          onPointerDown={(e) => e.stopPropagation()}
        >
          {ASPECT_RATIOS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {node.isMock && <span className="GenerateNode-mock-badge">demo</span>}
      </NodeRow>
    </>
  );
}
