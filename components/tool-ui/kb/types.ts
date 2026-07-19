// KB tool result shapes returned by backend/tool/kb.ts. Shared between
// search_kb / search_graph (chunks) and list_documents (row list).

export type KbDocument = {
  chunkId: string;
  documentId: string;
  docTitle: string;
  pageNumbers: number[];
  content: string;
  rrfScore: number;
  legsHit: Array<"kw" | "vec" | "tag" | "mention" | "full">;
};

export type KbToolResult = {
  content: string;
  documents: KbDocument[];
  empty: boolean;
};

export type ParseOutcome =
  | { kind: "ok"; result: KbToolResult }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "loading" };

export type ListDocResult = {
  documents?: Array<{ id: string; title: string; status: string }>;
  total?: number;
  empty?: boolean;
};
