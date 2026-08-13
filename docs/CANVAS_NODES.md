# Canvas Nodes (Design)

The canvas ([docs/CANVAS.md](./CANVAS.md)) lets the user fill a React Flow
stage with nodes + edges. The **node editor** layer adds a small set of
purpose-built nodes — draggable cards with typed inputs and typed
output ports — that the user can wire together like a ComfyUI
pipeline. Visual layout, no execution engine.

## Why these two layers

The point of a node editor is to let the user compose **structured
intent** without writing prose. The canvas's plain shapes (rectangles,
text, images) are fine for free-form notes, but they don't carry
typed connections — there's no way to say "this prompt feeds into this
generator". Nodes + ports give us that.

We deliberately **don't run the graph on the canvas**. The agent runs
the LangGraph. The canvas is just a visual editor that, on click of
"Run pipeline", serializes the graph into a LangGraph user message —
the agent then orchestrates the actual `generate_image` calls (or
whatever tool fits the node types) using its existing tools and
credits. Composition + delegation, not a parallel execution engine.

## Data flow

```
                  ┌─────────────┐
                  │   Canvas    │
                  │             │
                  │  [Prompt]   │  user types "cat on windowsill"
                  │     │ text  │
                  │     ▼       │
                  │ [Generate]  │  aspect = square
                  │     │ image │
                  │     ▼       │
                  │ [Preview]   │
                  │             │
                  └──────┬──────┘
                         │ click "Run pipeline"
                         ▼
              serialize(graph) → user message:
              "Run this pipeline:
                1. Prompt: 'cat on windowsill'
                2. Generate (aspect: square)
                3. Preview"
                         │
                         ▼
              LangGraph agent (existing flow)
              sees the message, calls generate_image,
              result lands in the chat stream
                         │
                         ▼
              generate_image tool UI card
              → "Insert into Preview node"
              → CanvasProvider.createNode + binding
              → Preview node renders the image
```

## Node types (MVP)

Three shipped, more slot in trivially:

| `type`     | Inputs                                         | Outputs | Purpose                                                                                                         |
| ---------- | ---------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `prompt`   | —                                              | `text`  | A text input the user can fill in. The default value is a starter prompt.                                       |
| `generate` | `prompt` (text, multi), `image` (optional ref) | `image` | Calls `generate_image` (fal.ai via the LangGraph tool). `aspectRatio` selector (square / portrait / landscape). |
| `preview`  | `image` (or `text`)                            | —       | Renders the upstream image. Has an optional caption field.                                                      |

The edge + handle system is plain `@xyflow/react` — the line is
xyflow's `Edge` component; the port record is implicit in `sourceHandle`
/ `targetHandle` strings (e.g. `"output"`, `"input"`). `zIndex` keeps the
edges under the nodes so drag handles stay clickable.
nodes in the z-order.

## What we don't ship (yet)

The original starter has 17 node types (model, generate_text,
controlnet, load_image, blend, adjust, upscale, ip_adapter,
style_transfer, prompt_concat, number, router, iterator, capture,
preview, prompt, generate) plus an execution engine with topological
ordering and per-node status. We stripped all of that:

- **No execution engine.** Agent orchestrates. The `execute()` body
  on each node is a pass-through that returns the resolved inputs.
- **No on-canvas "Run" button on each node.** The trigger lives at
  the canvas level (a future "Run pipeline" toolbar button).
- **No ComfyUI-style worker.** We don't host a Cloudflare Worker doing
  diffusion — the `generate_image` tool calls fal.ai directly.
- **No pipeline regions / template picker.** No need yet — the agent
  places nodes, the user edits them.

## Where things live

```
components/canvas/
  constants.tsx                    port data types + colors + sizes
  utils.ts                         EditorAtom (re-exported from starter)
  OnCanvasNodePickerStub.ts        state atom only (no UI — agent places nodes)
  nodes/
    NodeShapeUtil.tsx              the 'node' shape (renders header + body + footer)
    nodeTypes.tsx                  node registry + dispatch
    nodePorts.tsx                  port info resolution (cached)
    resizeNode.ts                  resize math
    types/
      shared.tsx                   NodeDefinition base class + helpers
      PromptNode.tsx               text input node
      GenerateNode.tsx             fal.ai-backed generate node
      PreviewNode.tsx              image render node
  connection/
    ConnectionShapeUtil.tsx        the 'connection' shape
    ConnectionBindingUtil.tsx      links connection ↔ node ports
    ConnectionCenterHandleOverlayUtil.tsx   middle-of-connection insert handle
    keepConnectionsAtBottom.tsx    z-order side-effect
    insertNodeWithinConnection.tsx splitter (uses the stubbed picker state)
  ports/
    Port.tsx                       the dot you click to start a connection
    portState.ts                   editor atom for port hover / hinting
    portCompatibility.ts           data-type compat check
    getPortAtPoint.tsx             hit-test for ports
    PointingPort.tsx               custom 'select.pointing_port' tool
  icons/                           node header icons (Prompt, Generate, Preview, …)
  utils/sleep.ts                   stub sleep helper (PromptNode uses it)
app/canvas-nodes.css               .NodeShape / .Port / .ConnectionShape styles
```

All of this is mounted from `components/chat/CanvasEditor.tsx` —
the wrapper passes the shapes / bindings / overlay arrays into
`<Tldraw>` and installs the `PointingPort` tool into the `select`
state child.

## Bridge to the rest of the app

`lib/canvas/context.tsx` extends with `createNode({ type, props })` so
the agent (or a tool UI card) can drop a node on the canvas. The MVP
flow:

1. `generate_image` tool UI card gets a "Insert into pipeline" button.
2. The card calls `useCanvas().createNode({ type: 'prompt', props: { text: '...' } })` → returns a `TLShapeId`.
3. Same card calls `createNode({ type: 'generate' })` and `createNode({ type: 'preview' })`.
4. The card creates the three bindings: `prompt.output → generate.prompt`, `generate.output → preview.image` via `editor.createBinding({ type: 'connection', fromId, toId, props: { ... } })`.

Conceptually the flow is the same as React Flow's `addEdge` — the
starter's `ConnectionShapeUtil` + `ConnectionBindingUtil` give us the
UI for free once we have the binding record.

## "Run pipeline" → user message

When the user clicks Run, a new helper serializes the graph:

```ts
type SerializedPipeline = {
  nodes: Array<{
    id: string;
    type: "prompt" | "generate" | "preview";
    props: Record<string, unknown>;
  }>;
  edges: Array<{
    fromNode: string;
    fromPort: string;
    toNode: string;
    toPort: string;
  }>;
};

function serializePipeline(editor: Editor): SerializedPipeline {
  // walk all 'node' shapes, collect their props
  // walk all 'connection' bindings, resolve port ids → node ports
}
```

The helper turns that into a user message and sends it via the
assistant-ui runtime — LangGraph sees the message, the agent reasons
about the pipeline, and the tools it has (`generate_image`, etc.)
execute. The agent doesn't need any new tools; it just reads the
serialized pipeline from the user message and calls the existing
ones with the right args.

When the agent returns a `generate_image` result, the tool UI card
already has the "Add to canvas" wiring (see
`components/tool-ui/image/generate-image-card.tsx`). The new variant
of that button targets the existing `preview` node via the node graph
side-channel (`{ previewNodeId }` parameter), so the result lands in
the right place.

## Why this is the right shape

- **Reuse everything.** The agent, `generate_image`, the credit
  system, the assistant-ui runtime, the canvas auto-save — none of
  this needs a new path. We just add a way to _input_ structured
  intent.
- **No new execution engine.** LangGraph's checkpointer + memory +
  stream mode are exactly what we want for "run this pipeline"; we
  don't write a parallel one.
- **No schema explosion.** The node `type` is a string literal; adding
  a new node is `NodeDefinitions.newNode = NewNodeDefinition`. The
  serialiser walks the same registry.
- **Canvas persistence is unchanged.** `canvas_snapshots` is the same
  row; the React Flow document JSON just happens to contain a few
  typed nodes mixed with whatever the user adds. The auto-save
  debounce covers both.

## Future work

- **Run pipeline button** in the canvas toolbar (composes the user
  message + dispatches).
- **More node types** — easy to add: `model` (provider/modelId picker),
  `load_image` (URL → image), `crop` / `resize` (post-process).
- **Per-node agent calls** — instead of one-shot "Run pipeline", each
  node could have a per-node "Run me" button that sends a targeted
  user message ("Just generate for this node"). The plumbing already
  supports it; the node graph is just the structure.
- **Inline node preview of upcoming edits** — when the agent is about
  to call `generate_image`, buttkit the preview node with a placeholder
  skeleton so the user sees the pipeline pulsing before the result
  arrives.
