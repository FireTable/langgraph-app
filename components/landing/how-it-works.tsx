// ponytail: how-it-works shells are server-rendered. Each motion
// explainer is a client island so the static copy arrives in the
// initial HTML and the animation only attaches on hydration.

import type { FC } from "react";

import { BackgroundSplitDemo } from "@/components/landing/motion/background-split-demo";
import { HumanInTheLoopDemo } from "@/components/landing/motion/human-in-the-loop-demo";
import { KbExplainerDemo } from "@/components/landing/motion/kb-explainer-demo";
import { MemoryRecallDemo } from "@/components/landing/motion/memory-recall-demo";
import { ObservabilityWaterfallDemo } from "@/components/landing/motion/observability-waterfall-demo";
import { StreamingTokensDemo } from "@/components/landing/motion/streaming-tokens-demo";

export const HowItWorks: FC = () => (
  <section id="how-it-works" className="border-b border-border/60">
    <div className="mx-auto w-full max-w-6xl px-6 py-24">
      <div className="mb-16 flex flex-col gap-3">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">How it works</h2>
        <p className="text-muted-foreground max-w-2xl text-base">
          Each piece of the system has a scroll-driven explainer below. They run on real code paths
          in the project — the same shapes, same state, same animation choices.
        </p>
      </div>

      <div className="flex flex-col gap-24">
        <ExplainRow
          eyebrow="Streaming"
          title="Tokens appear the moment the model emits them."
          body="The chat runtime subscribes to a LangGraph stream. Each token is appended to the message in place; the assistant-ui markdown renderer keeps a blinking caret on the trailing line. Aborts cancel at the SDK layer — no half-written replies ever reach the database."
        >
          <StreamingTokensDemo />
        </ExplainRow>

        <ExplainRow
          eyebrow="Multi-graph"
          title="Two graphs, one turn. The chat hands off, the background finishes."
          body="When the chat graph completes a turn, it dispatches a runs.create to a second graph on a fresh AbortSignal. The user already has the reply; memory, observability, and thread housekeeping run after."
          reverse
        >
          <BackgroundSplitDemo />
        </ExplainRow>

        <ExplainRow
          eyebrow="Memory"
          title="The model sees what you told it. Across threads."
          body="On every turn, a small system block surfaces stable user facts and a short summary of recent threads. The chat graph reads the block, not the raw history. The Memory settings tab lets you review and delete what's stored."
        >
          <MemoryRecallDemo />
        </ExplainRow>

        <ExplainRow
          eyebrow="Observability"
          title="Every span, every call, one waterfall."
          body="A single capturing handler subscribes to the chat and background runs in parallel. Spans are written to Postgres under a per-turn key, redacted at the boundary, and rendered as a collapsible tree in the right panel."
          reverse
        >
          <ObservabilityWaterfallDemo />
        </ExplainRow>

        <ExplainRow
          eyebrow="Human in the loop"
          title="Some tools only run with your sign-off."
          body="LangGraph's interrupt() halts a run mid-execution, hands control to the user, and resumes when they send a payload back. Locations, wallet picks, trade confirmations — every input that needs judgement passes through one card chrome."
        >
          <HumanInTheLoopDemo />
        </ExplainRow>

        <ExplainRow
          eyebrow="Knowledge base"
          title="Drop a file (or paste a URL), query the entity graph."
          body={
            <>
              <p>
                Seven source kinds plus pasted URLs land in one pipeline — PDF, images, plain text,
                markdown, and the three Office Open XML formats (DOCX, XLSX, PPTX). PDFs and images
                go through vision OCR; Office formats are parsed structurally by{" "}
                <code>officeparser</code> (one page per slide / sheet, with embedded images
                extracted to R2); text and markdown skip straight to chunking; pasted URLs are
                fetched server-side via Jina Reader and land as a markdown attachment. Every chunk
                is embedded and run through an entity-extraction pass — relationships, themes, and
                entity names all become structured columns the retrieval legs can score on.
              </p>
              <p>
                <span className="text-foreground font-medium">Hybrid Search:</span> three legs run
                in one round-trip — <span className="text-foreground font-medium">BM25</span> for
                the exact term, <span className="text-foreground font-medium">pgvector</span> cosine
                for semantic closeness, and an{" "}
                <span className="text-foreground font-medium">entity-overlap</span> leg that walks
                the graph from your query node. The three are fused with{" "}
                <span className="text-foreground font-medium">RRF</span> (Reciprocal Rank Fusion).
              </p>
            </>
          }
          reverse
        >
          <KbExplainerDemo />
        </ExplainRow>
      </div>
    </div>
  </section>
);

type ExplainRowProps = {
  eyebrow: string;
  title: string;
  // ponytail: ReactNode so a row can pass multi-paragraph copy
  // (e.g. the KB row splits ingest / search / rerank / scopes
  // into separate <p> blocks). Plain-string bodies still work.
  body: React.ReactNode;
  reverse?: boolean;
  children: React.ReactNode;
};

const ExplainRow: FC<ExplainRowProps> = ({ eyebrow, title, body, reverse, children }) => (
  <div
    className={
      "grid grid-cols-1 items-start gap-10 lg:grid-cols-2" +
      (reverse ? " lg:[&>*:first-child]:order-2" : "")
    }
  >
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{eyebrow}</p>
      <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h3>
      {/* ponytail: a div (not <p>) so callers can pass a Fragment of
          multiple <p> blocks for longer copy. Space-y-3 keeps the
          rhythm consistent whether the body is a string or 4 paragraphs. */}
      <div className="text-muted-foreground space-y-3 text-base leading-relaxed">{body}</div>
    </div>
    <div className="border-border/60 bg-card text-card-foreground flex items-start justify-center overflow-hidden rounded-2xl border p-6">
      {children}
    </div>
  </div>
);
