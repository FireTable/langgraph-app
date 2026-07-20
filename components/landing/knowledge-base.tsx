// ponytail: dedicated KB landing section. Sits between Features and
// How-it-works — the bento above already advertises the headlines
// (chat anything, memory, dual-graph, observability), this section
// gives the KB pipeline the depth it needs to land. Mirrors the
// ExplainRow pattern from HowItWorks so the two sections read as
// the same design language. Server-rendered chrome, client motion
// island for the pipeline diagram.

import type { FC } from "react";

import { KbPipelineDemo } from "@/components/landing/motion/kb-pipeline-demo";

export const KnowledgeBase: FC = () => (
  <section id="knowledge-base" className="border-b border-border/60">
    <div className="mx-auto w-full max-w-6xl px-6 py-24">
      <div className="mb-16 flex flex-col gap-3">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Knowledge base, end to end.
        </h2>
        <p className="text-muted-foreground max-w-2xl text-base">
          Drop a PDF. The pipeline renders each page, OCRs the markdown, splits it, embeds the
          chunks, and runs an LLM to extract entities and themes. Ask a question, get grounded
          answers back — cited, scored, and reranked.
        </p>
      </div>

      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Ingest
          </p>
          <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            PDF → OCR → chunks → embeddings → entity graph.
          </h3>
          <p className="text-muted-foreground text-base leading-relaxed">
            Each stage is its own LangGraph node. The KB agent runs on a fresh AbortSignal alongside
            the chat reply, so the user&apos;s answer is never blocked on the heavy leg. Per-row
            status writes show chunks flipping from <code>parsing</code> → <code>success</code> as
            each entity-extract LLM lands.
          </p>
          <ul className="text-muted-foreground flex flex-col gap-2 text-sm leading-relaxed">
            <li>
              <span className="text-foreground font-medium">Hybrid search</span> — three legs (BM25
              keyword, pgvector cosine, JSONB entity overlap) merged via RRF, optionally reranked.
            </li>
            <li>
              <span className="text-foreground font-medium">@mentions</span> — chat-side directives
              that scope a search to a single doc or folder; the LLM copies the id verbatim into the
              tool call.
            </li>
            <li>
              <span className="text-foreground font-medium">Four reprocess modes</span> — full
              re-OCR, chunks only, retry failed pages, retry failed chunks. Pick the cheapest fix;
              the doc row tells you which.
            </li>
          </ul>
        </div>
        <div className="border-border/60 bg-card text-card-foreground flex items-start justify-center overflow-hidden rounded-2xl border p-6">
          <KbPipelineDemo />
        </div>
      </div>
    </div>
  </section>
);
