# Knowledge Base

How the assistant processes uploaded files (PDFs), indexes them using hybrid
search legs, resolves `@` mentions in chat messages, and queries relevant
content dynamically.

The ingestion pipeline lives under `backend/agent/kb-agent.ts`; the database
schemas and query APIs under `lib/kb/`; the user-facing settings under
`components/settings/kb-view/`; the chat-side mention resolution under
`lib/kb/resolve-mentions.ts`; and the chat Tool UI under
`components/tool-ui/kb/`.

---

## 1. Directory Structure & Layout

- **`backend/agent/kb-agent.ts`** — Background ingestion agent. Orchestrates
  PDF parsing, page rendering (screenshots), text splitting, embedding
  generation, and entity/relationship extraction.
- **`lib/kb/`** — Database schema (`schema.ts`), queries (`queries.ts`),
  environment loader (`env.ts`), resolve (`resolve.ts`),
  ingest dispatch (`ingest.ts`), ingest handler factory
  (`ingest-handlers.ts`), URL fetcher (`url.ts`), screenshot helpers
  (`screenshot.ts`), text utilities (`text.ts`), entity color map
  (`entityColor.ts`), LRU cache (`cache.ts`), and hybrid search +
  Reranker (`search.ts`).
- **`lib/kb/resolve.ts`** — Server-side middleware that runs at
  LLM-invoke time (`prepareMessagesForInvoke`): replaces every
  `kb_ref`-bearing part on every `HumanMessage` with a text part
  containing either the concatenated chunks or a status placeholder.
  Two shapes are accepted today — file part with `kb_ref` sibling
  (canonical) and the legacy standalone `{ type: "kb_ref", docId }`
  part (back-compat for older threads). Never modifies `state.messages`
  at rest.
- **`components/assistant-ui/kb-mention-formatter.ts`** +
  **`components/assistant-ui/kb-mention.tsx`** — Client-side
  serializer / parser for the `:kb-document[label]{documentId=…}` /
  `:kb-folder[label]{folderId=…}` directive tokens, plus the chip +
  formatters used inside the chat composer.
- **`components/settings/kb-view/`** — Settings UI dashboard (document
  tables, folder sidebar, reprocess dialog, Folder Graph, doc detail,
  Observability popover).
- **`components/tool-ui/kb/`** — Chat-side rendering for retrieval
  outputs (collapsible chunk list, score badges, retrieval source
  indicators).

---

## 2. Database Schema

Three tables and two enums, all in `lib/kb/schema.ts`. See
[`docs/DB.md`](./DB.md#knowledge-base) for the column-level contract; this
section is the design rationale.

### Enums

- `kb_doc_status` — `pending | parsing | success | failed`. Lives on
  `kb_document.status`; mirrors the macro OCR + chunk pipeline.
- `kb_chunk_status` — same four values, independent of the parent doc so
  a failed chunk-extract on one chunk can mark that chunk `failed`
  without downgrading the whole document (user still sees Ready in the
  table; the doc detail dialog surfaces per-chunk failures).

### Tables

- **`kb_folder`** — per-user grouping. `(user_id, name)` is unique so the
  default "Attachments" folder auto-creates idempotently on first upload.
  Cascade-delete from `user`.
- **`kb_document`** — one row per ingested document. `attachment_id` is
  the source FK (chat upload → KB OR URL flow's synthesized R2 object).
  `pages` is a `jsonb` array carrying
  `{ pageIndex, imageUrl, markdown, referenceText, status }`; the chunk
  pipeline reads from here without re-processing the source. PDFs and
  images produce one page per source page/screenshot; markdown / plain
  text / URL flows produce a single page with `markdown` pre-baked and
  `status='success'`; Office (DOCX/XLSX/PPTX) produces one text page
  plus one imageUrl page per embedded image (vision OCR). `content_hash`
  is sha256 (or `r2key:<key>` fallback) and is the primary dedup key
  across all seven source kinds.
- **`kb_chunk`** — one row per text chunk. Holds the `vector(1024)`
  embedding (BAAI/bge-m3 dim, served by apimart under
  `OPENAI_EMBEDDING_MODEL`), and a generated `tsvector` (language-neutral,
  `to_tsvector('simple', content) STORED`) for the BM25 leg.
- **`kb_entity`** — canonical extracted entities per document with 1024-dim
  vector embeddings for GraphRAG ANN entrypoint retrieval (`name`, `type`,
  `description`, `source_chunk_ids`, `embedding`).
- **`kb_relationship`** — extracted graph relationships connecting entity pairs
  with 1024-dim vector embeddings for GraphRAG global retrieval (`source`, `target`,
  `relation`, `description`, `source_chunk_ids`, `weight`, `embedding`).

### Indexes

- `kb_document_user_contenthash_idx` — **unique** `(user_id, content_hash)`;
  the dedup path (`screenshotNode` probes this on every upload).
- `kb_chunk_embedding_idx` — HNSW over `embedding vector_cosine_ops`.
- `kb_chunk_tsv_idx` — GIN over the generated `tsvector` (`'simple'` BM25 leg).
- `kb_entity_embedding_idx` — HNSW over `kb_entity.embedding vector_cosine_ops`.
- `kb_relationship_embedding_idx` — HNSW over `kb_relationship.embedding vector_cosine_ops`.

### Why an `attachment_id` and not a stored `r2_key`

`kb_document.attachment_id` FKs into the `attachments` table (R2-backed,
see [`docs/ATTACHMENTS.md`](./ATTACHMENTS.md)). This keeps the KB out of
the upload-path concern: the same attachment can power a chat message
and a KB doc without re-uploading bytes, and retention / dedup /
presigned-URL rules live in one place.

---

## 3. Ingestion Pipeline

When a document is uploaded (chat composer, Settings → KB Add dialog,
or URL paste), it is routed to the background `kbAgent` graph for
ingestion. Four source kinds share the same downstream pipeline —
they diverge only in the `splitFileToPageNode` factory dispatch:

```
                    ┌─── pdf ──────► mupdf render + native text extract + R2 PNG upload
                    │
                    ├─── markdown ─► bytes → utf-8 → single pre-baked markdown page
                    │
                    ├─── plain ────► same as markdown
                    │
Upload ─▶ parse ────┤
                    ├─── image ────► bytes → R2 PNG/JPEG/WebP upload → single imageUrl page
                    │
                    └─── office ───► officeparser → N markdown pages (1 per PPTX slide / XLSX sheet,
                    (docx/xlsx/      1 page for DOCX); images are inlined as R2 ![](url) refs in
                     pptx)           page markdown (no separate vision OCR pass). Layout / group-
                                    shape images not surfaced by officeparser's AST walker are
                                    recovered via a self-extracted PPTX rels scan and inline-inserted.
                                                                                 │
                                                                                 ▼
                                          MarkdownTextSplitter → Embed (BAAI/bge-m3) → Entity extract
```

1. **Placeholder Creation** — Immediately inserts a document row with
   `status = 'parsing'` so the Settings table shows a row before any
   work has been done.
2. **Source-specific page construction** — `splitFileToPageNode`
   dispatches via `getIngestHandler(mimeType)` from
   `lib/kb/ingest-handlers.ts`. PDF keeps the mupdf render + extract
   pipeline; markdown / plain text read the bytes as utf-8 and produce
   a single pre-baked page (`status='success'`); image uploads to
   `u/<userId>/kb/<sha256>.<ext>` (content-addressed via the R2 keys
   factory — same image bytes across N docs share one R2 object) and
   produces a single page with `imageUrl` set + `status='pending'`;
   **Office Open XML (DOCX/XLSX/PPTX)** goes through a single
   `officeHandler` that uses `officeparser` and paginates by kind —
   PPTX splits by `slide`, XLSX by `sheet`, DOCX stays a single page
   (Word pagination is dynamic so there's no top-level page node to
   slice on). Each page's markdown is generated from a sub-AST with
   `includeImages: true`, so embedded images land inline as
   `![](kb/<sha>.png)` refs (R2 URLs are resolved by walking the AST
   and rewriting `metadata.url` per image node — same images shared
   across pages are PUT once via a `Promise<string>` dedup cache
   layered on top of the sha-keyed R2 dedup). officeparser's AST walker
   misses two image classes that the handler recovers itself: layout
   images (PPTX `ppt/slideLayouts/`) and images inside group shapes
   (`<p:grpSp>`) — both visible in the doc zip's `.rels` files but not
   in the walker output. The recovery pass unzips the PPTX (via
   `fflate`), parses each slide's rels to find its layout + its
   direct image refs, then appends `![](r2-url)` to every page that
   inherits the orphan. PPTX-only for now — XLSX/DOCX have no
   equivalent "page inheritance" concept. Charts are skipped
   (`officeparser` doesn't surface `chartData` and there's no code
   path to use it). Each page carries a `status` mirror written by
   `pageToMarkdownNode`.
3. **Text Chunking** — `MarkdownTextSplitter` (from `@langchain/textsplitters`)
   over the joined page markdown. Chunk size is `KB_CHUNK_MAX_CHARS`
   (default 2000). Rows are inserted with `embedding = NULL` (migration
   `0015_romantic_sir_ram.sql`) — chunk vectors are written by
   `chunk-embed-node.ts` AFTER alignment so the bge-m3 vector can
   capture post-alignment canonical names (LightRAG augmented text,
   see step 5).
4. **Entity Extraction** — For each chunk, the LLM extracts entities
   (`{name, type, description}[]`), relationships
   (`{source, target, relation, description}[]`), and themes
   (`text[]`). Stored in dedicated `kb_entity` / `kb_relationship`
   tables (rows link back to chunks via `source_chunk_ids: text[]`)
   and `kb_theme` (one row per `(chunk_id, name)`). The tag leg
   reads entities / themes; the Folder Graph dedupes per chunk.
5. **Vector Generation + Alignment** — `chunk-embed-node.ts` runs
   THREE legs in one pass:
   - **Chunk leg** — LightRAG-style augmented text
     `content + Entities: ... + Relationships: ... + Themes: ...`
     (empty graph sections are dropped). 1024-dim bge-m3 vectors via
     the `OPENAI_EMBEDDING_MODEL` alias, written to `kb_chunk.embedding`
     with `updated_at = NOW()` (raw SQL — Drizzle's `vector`
     customType needs a hand-built `[1,2,...]::vector` literal;
     `upsertChunkEmbedding` does this). Chunks whose id is in
     `state.entityExtractedChunks` ALWAYS re-embed on retry so the
     vector reflects the latest graph metadata.
   - **Entity leg** — JOINs `kb_theme` for each entity's
     `source_chunk_ids` and concatenates `themes.join(' ')` onto
     the embed string so the ANN vector carries the chunk's macro
     topics (audit §13b 456).
   - **Relationship leg** — same shape as entity leg, on
     `kb_relationship.embedding`.
     Before any of these legs, `resolveEntityAliasesForDoc` rewrites
     `kb_entity` / `kb_relationship` rows in place — entity alias
     mappings cascade into `kb_relationship.source / target` so graph
     context stays self-consistent (no dangling edges).
6. **Status Flip** — `kb_document.status` flips to `success` (or
   `failed` if any node throws); `kb_chunk.status` reflects per-chunk
   outcome. `kbAgent.mode` (`full | chunksOnly | retryFailed |
retryFailedChunks`, set by the route) changes which nodes run — see
   §6.

Concurrency: OCR and entity-extract share a `p-queue` of width
`KB_OCR_CONCURRENCY` / `KB_ENTITY_CONCURRENCY` (default 5 each, see
`lib/constants.ts`). Bump both together if the upstream rate-limit
tier changes.

### Per-kind reference — what each source type does at every stage

The table pins the full pipeline behaviour for every supported content type. Use it as a quick lookup when adding a new kind or debugging a missing artifact.

| Kind         | Per-page shape (`PageResult`)                                                                                                                                                                                             | R2 uploads                                                                                                                        | LLM calls                             | Pages tab UI                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| **pdf**      | `{ imageUrl: full-page PNG, referenceText: native text layer, textBlocks: [{text, bbox}], imageRefs: [{name, url, bbox, w, h}], markdown: "" (pending), status: "pending" }` → OCR fills `markdown`, flips to `"success"` | full-page screenshot (`page-{N}.png`) + every embedded raster image (`img-p{N}-{idx}.png`)                                        | OCR (vision) + Embed + Entity Extract | N pages · left column: page image + reference text · right column: markdown |
| **markdown** | `{ imageUrl: "", markdown: file bytes as utf-8, status: "success" }` — no further work                                                                                                                                    | —                                                                                                                                 | Embed + Entity Extract                | 1 page · markdown only                                                      |
| **plain**    | `{ imageUrl: "", markdown: file bytes as utf-8, status: "success" }` — no further work                                                                                                                                    | —                                                                                                                                 | Embed + Entity Extract                | 1 page · markdown only (tab label reads "Text")                             |
| **image**    | `{ imageUrl: original bytes uploaded to R2, markdown: "" (pending), status: "pending" }` → OCR fills `markdown`, flips to `"success"`                                                                                     | original image (`image.{ext}`)                                                                                                    | OCR (vision) + Embed + Entity Extract | 1 page · left: original image · right: markdown                             |
| **docx**     | `{ imageUrl: "", markdown: officeparser output for the whole AST + inline `![](r2-url)` refs, status: "success" }` — single page (Word pagination is dynamic, no top-level page node)                                     | every embedded image (`{baseName}.{ext}`, cross-page dedup)                                                                       | Embed + Entity Extract                | 1 page · markdown only                                                      |
| **xlsx**     | one page per `sheet` node: `{ imageUrl: "", markdown: that sheet's officeparser output + inline image refs, status: "success" }`                                                                                          | every embedded image (cross-page dedup)                                                                                           | Embed + Entity Extract                | N pages (one per sheet) · markdown only                                     |
| **pptx**     | one page per `slide` node: `{ imageUrl: "", markdown: that slide's officeparser output + inline image refs + layout/group-shape orphan backfill, status: "success" }`                                                     | every embedded image + every layout / group-shape orphan image recovered via `fflate` self-extracted rels scan (cross-page dedup) | Embed + Entity Extract                | N pages (one per slide) · markdown only                                     |

Key takeaways:

- **Office docs and PDF produce structured hints for the OCR LLM.** PDF pages ship `textBlocks` (paragraphs with y-position) and `imageRefs` (pre-uploaded R2 URLs with bbox) so `pageToMarkdownNode` can hand the vision LLM real image URLs to reference instead of letting it hallucinate them.
- **Office docs do NOT call OCR.** officeparser reads the OOXML structure directly and emits markdown; calling OCR on a page screenshot would lose the structural information (tables, list nesting, headings) that the parser already extracted.
- **PDF and image MUST call OCR.** PDFs have no structural markdown mapping (only positioning info); images have no text at all. The vision LLM is the only path to clean markdown.
- **Vector graphics are not extracted.** `extractPdfImages` walks `page.run(device, ...)` and only catches `fillImage` calls. Logos composed of `fillPath` / `strokePath` (e.g. Binance PDF's BINANCE wordmark) are NOT surfaced — they remain visible only inside the page PNG that OCR sees.
- **Cross-page image dedup happens at the R2 layer.** Both office handlers (Promise<string> cache by attachment name) and the PDF handler (sha-keyed R2 keys) collapse same bytes to one R2 object. A logo embedded N times across N pages of one doc, or across N docs, references one R2 object regardless of bbox.

---

## 4. Hybrid Search & Reranking

Hybrid search is a single database round-trip (PostgreSQL CTEs +
UNION ALL) combining three retrieval legs, fused with RRF, optionally
re-scored by a Reranker model:

```
User Query
    │
    ├─► Leg 1: Sparse (tsvector @@ websearch_to_tsquery) ──► Top 50 ─┐
    ├─► Leg 2: Dense  (pgvector <=> query_embedding)     ─► Top 50 ─┼─► RRF
    └─► Leg 3: Tag    (entities jsonb overlap)            ─► Top 30 ─┘   │
                                                                        ▼
                                                              Candidate Pool
                                                                        │
                                                              Reranker Model
                                                                        │
                                                              Min-Score Filter
                                                              (>= KB_RERANK_MIN_SCORE)
                                                                        │
                                                                        ▼
                                                                Final Top-K
```

### A. The three legs

- **Keyword (`kw`)** — `tsvector @@ websearch_to_tsquery(query)`, sorted
  by `ts_rank_cd DESC`. Top 50.
- **Vector (`vec`)** — `c.embedding <=> query_embedding` (cosine
  distance). Top 50. The query is embedded via the same `OPENAI_EMBEDDING_MODEL`
  alias the ingest uses; the resulting vector is passed as a parameter
  (not a SQL literal) so a 1024-dim array round-trips through
  `postgres.js`.
- **Tag (`tag`)** — Query is split into lowercase tokens (length
  $\geq 3$, Unicode-aware), intersected with `kb_chunk.entities[*].name`
  via `jsonb` containment. Sorted by entity-overlap count. Top 30.

### B. Reciprocal Rank Fusion (RRF)

The three legs are UNION-ALL'd inside one query, grouped by `chunk_id`,
and fused with RRF ($k=60$):

$$S_{RRF}(c) = \sum_{leg \in \{kw, vec, tag\}} \frac{1}{60 + rank_{leg}(c)}$$

If no Reranker is configured, the result is the top-K chunks from this
RRF-sorted list, returned as-is with `rrfScore` and `legsHit` populated
for the UI.

### C. Optional Reranker stage

If a Reranker model is registered (Cohere / Jina / etc. — configured
via the admin Rerank-model endpoint, see [`docs/ADMIN.md`](./ADMIN.md))
and `KB_RERANK_MIN_SCORE` is non-zero:

1. **Candidate expansion** — the SQL query is widened to
   `Math.max(50, topK * 5)` so the Reranker has enough material to find
   the right top-K.
2. **Rerank** — every candidate is scored $0.0 \sim 1.0$ for
   semantic similarity to the query.
3. **Threshold filter** — candidates below `KB_RERANK_MIN_SCORE`
   (default `0.4`) are dropped. This keeps irrelevant noise out of both
   the LLM context and the chat UI.
4. **Trim** — retain the top `topK` by Reranker score.

The Reranker is invoked only when configured; the SQL path is identical
otherwise. ToolMessage chips in the chat distinguish the two modes
(percentage vs three-decimal float, see §7).

---

## 5. Mention Resolution

The composer renders two KB directive tokens via assistant-ui's
`unstable_useMentionAdapter` + a custom
`kbMentionFormatter`:

- `:kb-document[label]{documentId=<UUID>}` — mention a single doc
- `:kb-folder[label]{folderId=<UUID>}` — mention a folder (the
  popover's first item per folder)

The brace-group key **matches the `search_kb` / `list_documents`
parameter name** so the LLM can copy the value verbatim into the
tool call — no ambiguity, no resolver in the loop.

The directive survives the SDK wire and lands in
`HumanMessage.content` as a plain string. From there the LLM does
the work:

- `:kb-document[…]` → `search_kb({ documentId: "<UUID>", query: <user's question> })`
  (or `list_documents({ documentId: "<UUID>" })` to inspect the doc)
- `:kb-folder[…]` → `search_kb({ folderId: "<UUID>", query: <user's question> })`
  or `list_documents({ folderId: "<UUID>" })` to enumerate

The system prompt
(`backend/prompt/system.ts`, `[KNOWLEDGE BASE]` clause) names the
two directive forms and tells the LLM to copy the id into the
matching tool arg. `search_kb` itself enforces per-user scoping,
so cross-user mentions return empty rather than leaking.

`backend/node/prepare-data-node.ts` is now a pass-through — no
pre-LLM resolver. The KB agent's `tool-loop` handles the full flow:

1. LLM reads the directive from `HumanMessage.content`
2. LLM calls `search_kb` (or `list_documents`) with the right filter
3. The tool returns the content; the LLM reasons over it

The chip survives the assistant-ui SDK wire because the SDK's
`contentToParts` rebuilds `text` parts from scratch but preserves the
directive substring verbatim — that's the whole reason the directive
is serialized as a typed `:type[label]{key=val}` token instead of a
custom `{type: "kb_ref"}` part (which the SDK filters to `null`).
`kb_ref` itself rides as a **sibling field on `type: "file"` parts**
— see the in-repo memory entry on `kb_ref rides as file sibling` for
the full rationale.

### Legacy format

The parser still accepts the old `:kb-document[label]{id=…}` /
`:kb-folder[label]{id=…}` form so existing transcript lines keep
rendering as chips. Only the formatter's `serialize` writes the new
typed keys — newly inserted chips always carry
`{documentId=…}` / `{folderId=…}`.

---

## 6. Reprocess Modes

The Settings → KB row actions expose four reprocess modes via
`POST /api/kb/documents/[id]/reprocess?mode=…`. See
[`docs/APIS.md`](./APIS.md#kb) for the request/response contract; this
section is the design rationale.

| Mode                | When to pick it                              | Re-runs                                     | Doc status during                |
| :------------------ | :------------------------------------------- | :------------------------------------------ | :------------------------------- |
| `full` (default)    | OCR / chunking is stale or wrong             | PDF render + OCR + chunk + embed + extract  | `parsing` → `success` / `failed` |
| `chunksOnly`        | pages cache is good, chunks are stale        | chunk + embed + extract on the cached pages | stays `success`                  |
| `retryFailed`       | some pages failed OCR                        | failed pages only + full re-chunk           | flips to `parsing`               |
| `retryFailedChunks` | chunk-extract failed on a handful of chunks | failed chunks only (in-place UPDATE)        | **stays `success`**              |

Key invariant: `retryFailedChunks` does **not** touch `doc.status` and
does **not** DELETE chunks. Failed chunks are marked `status='parsing'`
in place (id, ordinal, embedding, content all preserved), so the
IIFE inside `kbAgent.generateChunkEmbedNode` finds them by
`status='parsing'` and re-runs chunk-extract per row. DELETE+INSERT
here was the wrong design — `pageToMarkdownNode` skips under chunksOnly
/ retryFailed modes, so `fullMarkdown` is empty, the IIFE throws, and
the DELETE has already committed, leaving the doc with N−K chunks and
no recovery path.

The four modes map to a single `kbAgent.mode` enum that the agent's
own routing reads in `prepareKBDataNode` and `rewriteMessagesNode` (see
the in-repo memory entry on `router decision schema duplicated` — adding
a fifth mode means updating the enum in `state.ts` AND
`router-agent-node.ts` AND the `routeToSubAgent` union in `agent.ts`).

---

## 7. Frontend Visualisations

### Chat side — `components/tool-ui/kb/`

- **Retrieval badges** — Each chunk card shows which legs hit it
  (`VECTOR` / `BM25` / `ENTITY`), drawn from `legsHit` on the result
  row.
- **Score formatting** — Auto-detected per turn:
  - **Rerank mode** — when the top score is $> 0.05$, all scores render
    as percentages (`Score: 95%`).
  - **RRF mode** — otherwise, three-decimal floats
    (`Score: 0.033`).
- **Mode labels** — `Full Document` / `Pages` badges distinguish
  the 0-chunk fallback chunks (`legsHit: ["full"]`) from regular
  vector / BM25 hits. The chip is `c-synthetic-*` under the hood.
- **Collapsible list** — Shows the first 3 chunks by default; an
  "Expand (+N chunks)" text button reveals the rest. Bottom fade
  masks the truncation edge.

### Settings side — `components/settings/kb-view/`

- **Live poll indicator** — When the table is auto-refreshing
  (anyInflight or in the post-dispatch window), an emerald pulsing dot
  in the table header lights up. Hover shows the countdown to the next
  refresh (`Auto-refresh in Ns`). Driven by
  `KB_POLL_INTERVAL_MS` (default 5000) and the `isLivePolling` state
  lifted from `kb-view.tsx`.
- **Folder sidebar** — Lists every folder; the selected folder
  gets a doc-count badge, other folders show no count (their docs are
  scoped out of the `?folderId=` API response).
- **Folder Graph dialog** — Cross-doc force-directed graph of
  entities + relationships across every chunk in the folder. The
  entity color map is `graphRAG-native` (hue = neighbor signature, sat
  / light = degree) — single source of truth shared with the per-doc
  knowledge-graph canvas and the in-card entity badges.

---

## 8. Failure Modes

- **OCR partial failure** — `kb_document.pages[*].status='failed'` rows
  exist alongside successful pages. The chunk-join logic
  (`rewriteMessagesNode`) skips failed pages so they don't poison the
  splitter. The UI surfaces `X failed` on the page badge; pick
  `retryFailed` to re-run just those pages.
- **Embed failure on a single chunk** — `kb_chunk.status='failed'` for
  that row only. `kb_document.status` stays `success`. The doc table
  shows the doc as Ready; the doc detail dialog surfaces the chunk
  count breakdown (`Indexed N/M` + a failed badge). Pick
  `retryFailedChunks` to re-run chunk-extract in place.
- **Embed failure on the whole doc** — `kb_document.status='failed'`
  with `error_message` set. Reprocess (`full`) re-runs the whole
  pipeline. `retryFailedChunks` returns 409 `NOT_READY` because the doc
  is not in a terminal indexing state.
- **Cross-user `kb_document.id`** — `findKbDocumentById(userId, id)` is
  per-user scoped; the route returns 404 for ids the caller does not
  own (no existence leak — same convention as `/api/threads`).
- **Mention of an unknown id** — silently dropped. Mention of a
  cross-user id — same; `kb_document` is per-user scoped and the
  `lookupFolders`/`docsInFolders` calls filter by `userId`.

---

## 9. Configurable Environment Knobs

Server-only, read via `lib/kb/env.ts` (and `lib/constants.ts` for the
shared singletons):

| Env variable              | Default | Purpose                                               |
| :------------------------ | :------ | :---------------------------------------------------- |
| `KB_CHUNK_MAX_CHARS`      | `2000`  | Max character length of a single text chunk.          |
| `KB_HYBRID_TOPK_DEFAULT`  | `8`     | Default top-K returned by `search_kb`.                |
| `KB_HYBRID_TOPK_MAX`      | `20`    | Clamp on user-supplied `topK`.                        |
| `KB_RERANK_MIN_SCORE`     | `0.4`   | Threshold filter for the Reranker stage.              |
| `KB_MENTION_TOPK_DEFAULT` | `5`     | Per-mention top-K under Meta mode.                    |
| `KB_MENTION_TOPK_MAX`     | `20`    | Hard cap on per-mention top-K.                        |
| `KB_MENTION_TOKEN_BUDGET` | `8192`  | Total character cap across all mentions.              |
| `KB_OCR_CONCURRENCY`      | `5`     | Width of the OCR `p-queue`.                           |
| `KB_ENTITY_CONCURRENCY`   | `5`     | Width of the entity-extract `p-queue`.                |
| `KB_POLL_INTERVAL_MS`     | `5000`  | Settings-table + Preview-dialog auto-refresh cadence. |

Reranker choice (model id, provider) lives in the Admin → Providers
table — see [`docs/ADMIN.md`](./ADMIN.md).

---

## 10. Open Items / Out of Scope Today

- **Source URL ingestion** — done. Settings → KB → Add dialog
  accepts a URL; `lib/kb/url.ts` fetches via `r.jina.ai` (handles HTML
  - SPA + content negotiation server-side), the server uploads the
    result to R2 as `text/markdown`, and the rest of the pipeline
    picks it up via the same file-part path the chat composer uses.
- **Folder-level permissions** — All folders under a user are owned
  exclusively by that user. Sharing a folder across users is not yet
  modelled.
- **Reranker streaming** — Rerank is a single batched call after the
  SQL round-trip. A streaming variant (return top-K as soon as the
  Reranker scores them) is a future optimisation.
- **Multi-doc `@folder` re-chunk** — When a folder's docs are
  collectively re-chunked, each doc is still re-processed independently.
  A true folder-level pipeline is a v4 design.
- **`kebab-case` in directives** — The id capture (`[^\]\n]{1,1024}`)
  is liberal. Tightening to UUID-only would prevent accidental
  non-uuid id values but breaks future plans (e.g. short folder
  slugs).

## 11. Per-Doc Observability (Observability List popover)

Each `<DocRow>` exposes an Activity icon between RefreshCw and Search.
Click → `<ObservabilityPopover>` lazy-fetches
`GET /api/kb/documents/[id]/observability` (reads the `kb_observability`
table directly — no SDK call) and lists every **kbAgent re-run** for
the doc. The popover is a re-run history: chunksOnly / retryFailed /
retryFailedChunks reprocesses land here. Initial `full`-mode uploads
are NOT in the popover — the `kb_documents` row IS the event for those.

Each row carries `source` / `mode` / `createdAt`. Source is the
ingestion path: `kb-reprocess` for Settings reprocess (the only path
that currently populates the popover). Mode is the dispatch mode
(`chunksOnly` / `retryFailed` / `retryFailedChunks`); mode is shown
as a badge when not `full`. Click a row →
`openSheet({ threadId: run.threadId, parentMessageId: run.parentMessageId })`
opens the same singleton `<ObservabilitySheet>` the chat Activity
icon uses, scoped to that run's spans.

`threadId` is per-row, not top-level: standalone reprocess runs land
on `docId.replace(/^d-/, "")`; chat-path uploads (chat subgraph) land
on the chat thread. Per-row `threadId` lets the popover open the
sheet against the correct thread. `parentMessageId` is the synthetic
HumanMessage `id` (minted as `messageId` by `fireIngestionRun`,
standalone) or the user's chat msg `id` (chat path) — the same value
`CapturingHandler` stamps onto every span via `meta.parent_message_id`,
so the per-turn observability route scopes spans correctly.

Reprocess dispatch uses `multitaskStrategy: "interrupt"` — a fresh
reprocess cancels any in-flight run on the same thread (latest wins),
not the default enqueue.

See [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md#kb-ingestion-runs-settings--kb)
for the full wiring + rationale.
