// ponytail: typed env reader for KB retrieval knobs (issue #13 v3).
// All vars are server-only — surface values to the client only if a UI
// surface needs them. Rule #12 (env maintenance contract) — none of these
// are NEXT_PUBLIC_ because the only consumer is backend tool + mention
// resolver code; the frontend reaches them via API routes that read them
// server-side first.
//
// Defaults are picked from the community survey documented in
// `.claude/13-kb-v3.md`: LangChain/LlamaIndex/Haystack/Mastra 5–10
// fused topK, 512–1024 tokens per chunk, mention topK 5.

type KbEnv = {
  mentionTopKDefault: number;
  mentionTopKMax: number;
  mentionTokenBudget: number;
  hybridTopKDefault: number;
  hybridTopKMax: number;
  chunkMaxChars: number;
  rerankMinScore: number;
  kbGraphHops: number;
  kbHybridEntryTopK: number;
  kbGraphEnabled: boolean;
};

let cached: KbEnv | null = null;

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getKbEnv(): KbEnv {
  if (cached) return cached;
  cached = {
    mentionTopKDefault: readInt("KB_MENTION_TOPK_DEFAULT", 5),
    mentionTopKMax: readInt("KB_MENTION_TOPK_MAX", 20),
    mentionTokenBudget: readInt("KB_MENTION_TOKEN_BUDGET", 8192),
    hybridTopKDefault: readInt("KB_HYBRID_TOPK_DEFAULT", 8),
    hybridTopKMax: readInt("KB_HYBRID_TOPK_MAX", 20),
    chunkMaxChars: readInt("KB_CHUNK_MAX_CHARS", 2000),
    rerankMinScore: readFloat("KB_RERANK_MIN_SCORE", 0.4),
    kbGraphHops: readInt("KB_GRAPH_HOPS", 2),
    kbHybridEntryTopK: readInt("KB_HYBRID_ENTRY_TOPK", 50),
    kbGraphEnabled: readBool("KB_GRAPH_ENABLED", false),
  };
  return cached;
}

// ponytail: clear cached env when running tests so vi.stubEnv flips
// propagate. Production calls hit the cache once at boot.
export function _resetKbEnvCache(): void {
  cached = null;
}
