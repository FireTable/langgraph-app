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
  environment loader (`env.ts`), and hybrid search + Reranker
  (`search.ts`).
- **`lib/kb/resolve-mentions.ts`** — Server-side middleware that intercepts
  `@` mentions (docs or folders) in user messages and formats them for
  the LLM before the turn starts.
- **`components/assistant-ui/kb-mention-formatter.ts`** — Client-side
  serializer/parser for the `kb-document` / `kb-folder` directive tokens
  used inside the chat composer.
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
  a failed entity-extract on one chunk can mark that chunk `failed`
  without downgrading the whole document (user still sees Ready in the
  table; the doc detail dialog surfaces per-chunk failures).

### Tables

- **`kb_folder`** — per-user grouping. `(user_id, name)` is unique so the
  default "Attachments" folder auto-creates idempotently on first upload.
  Cascade-delete from `user`.
- **`kb_document`** — one row per ingested PDF. `attachment_id` is the
  source FK (chat upload → KB). `pages` is a `jsonb` array carrying
  `{ pageNumber, markdown, errorMessage }` per page; the chunk pipeline
  reads from here without re-OCR-ing. `content_hash` is sha256 (or
  `r2key:<key>` fallback) and is the primary dedup key.
- **`kb_chunk`** — one row per text chunk. Holds the `vector(1024)`
  embedding (BAAI/bge-m3 dim, served by apimart under
  `OPENAI_EMBEDDING_MODEL`), a generated `tsvector` (English,
  `to_tsvector('english', content) STORED`) for the BM25 leg, plus
  `entities` / `relationships` / `themes` JSONB columns seeded by the
  LLM-driven entity-extract pass.

### Indexes (the four that matter)

- `kb_document_user_contenthash_idx` — **unique** `(user_id, content_hash)`;
  the dedup path (`screenshotNode` probes this on every upload).
- `kb_chunk_embedding_idx` — HNSW over `embedding vector_cosine_ops`. The
  dim of the column, the dim of the index operator, and the dim of the
  embedder must all agree — `pgvector` rejects mismatched inserts with
  `22P02`.
- `kb_chunk_tsv_idx` — GIN over the generated `tsvector` (BM25 leg).
- `kb_chunk_entities_idx` — GIN over `entities jsonb` (entity-overlap
  leg + Folder Graph seed).

### Why an `attachment_id` and not a stored `r2_key`

`kb_document.attachment_id` FKs into the `attachments` table (R2-backed,
see [`docs/ATTACHMENTS.md`](./ATTACHMENTS.md)). This keeps the KB out of
the upload-path concern: the same attachment can power a chat message
and a KB doc without re-uploading bytes, and retention / dedup /
presigned-URL rules live in one place.

---

## 3. Ingestion Pipeline

When a document is uploaded (chat composer or Settings → KB), it is
routed to the background `kbAgent` graph for ingestion:

```
Upload ─▶ Status='parsing' ─▶ Parse PDF Pages ─▶ Text Split (LangChain)
                                                    │
  ┌─────────────────────────────────────────────────┘
  ▼
Generate Embeddings (Vector) ─▶ Extract Entities (JSONB) ─▶ Status='success'
```

1. **Placeholder Creation** — Immediately inserts a document row with
   `status = 'parsing'` so the Settings table shows a row before any
   work has been done.
2. **Page Processing** — Parses PDF bytes, renders high-resolution page
   screenshots (saved to R2 via the attachments store), and extracts
   markdown text page by page. Each page carries a `status` mirror
   (`pending | parsing | success | failed`) written by `pageToMarkdownNode`.
3. **Text Chunking** — `RecursiveCharacterTextSplitter` over the joined
   page markdown. Chunk size is `KB_CHUNK_MAX_CHARS` (default 2000).
4. **Vector Generation** — 1024-dim embeddings per chunk via the
   `OPENAI_EMBEDDING_MODEL` alias (BAAI/bge-m3). Written to `kb_chunk.embedding`
   inside a single `INSERT` (raw SQL — Drizzle's `vector` customType
   encodes the pgvector literal correctly only via a hand-built
   fragment; the bulk-insert helper does this).
5. **Entity Extraction** — For each chunk, the LLM extracts entities
   (`{name, type, description}[]`), relationships
   (`{source, target, relation, description}[]`), and themes
   (`text[]`). Stored as JSONB; the tag leg and the Folder Graph read
   from these columns directly.
6. **Status Flip** — `kb_document.status` flips to `success` (or
   `failed` if any node throws); `kb_chunk.status` reflects per-chunk
   outcome. `kbAgent.mode` (`full | chunksOnly | retryFailed |
retryFailedChunks`, set by the route) changes which nodes run — see
   §6.

Concurrency: OCR and entity-extract share a `p-queue` of width
`KB_OCR_CONCURRENCY` / `KB_ENTITY_CONCURRENCY` (default 5 each, see
`lib/constants.ts`). Bump both together if the upstream rate-limit
tier changes.

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
| `retryFailedChunks` | entity-extract failed on a handful of chunks | failed chunks only (in-place UPDATE)        | **stays `success`**              |

Key invariant: `retryFailedChunks` does **not** touch `doc.status` and
does **not** DELETE chunks. Failed chunks are marked `status='parsing'`
in place (id, ordinal, embedding, content all preserved), so the
IIFE inside `kbAgent.generateChunkEmbedNode` finds them by
`status='parsing'` and re-runs entity-extract per row. DELETE+INSERT
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
  `retryFailedChunks` to re-run entity-extract in place.
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

- **Source URL ingestion** — `kb_document` has no `source_url` column;
  URL ingestion is deferred to v3. Today everything goes through the
  `attachments` table (R2).
- **Folder-level permissions** — All folders under a user are owned
  exclusively by that user. Sharing a folder across users is not yet
  modelled.
- **Reranker streaming** — Rerank is a single batched call after the
  SQL round-trip. A streaming variant (return top-K as soon as the
  Reranker scores them) is a future optimisation.

## 7. Per-Doc Observability (Observability List popover)

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

- **Multi-doc `@folder` re-chunk** — When a folder's docs are
  collectively re-chunked, each doc is still re-processed independently.
  A true folder-level pipeline is a v4 design.
- **`kebab-case` in directives** — The id capture (`[^\]\n]{1,1024}`)
  is liberal. Tightening to UUID-only would prevent accidental
  non-uuid id values but breaks future plans (e.g. short folder
  slugs).
