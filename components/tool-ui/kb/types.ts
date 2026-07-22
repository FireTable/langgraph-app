// KB tool result shapes returned by backend/tool/kb.ts. Shared between
// search_KB (chunks) and list_documents (folder-grouped row list).

export type KbDocument = {
  chunkId: string;
  documentId: string;
  docTitle: string;
  pageNumbers: number[];
  content: string;
  rrfScore: number;
  scoreKind?: "rrf" | "rerank";
  legsHit: Array<"kw" | "vec" | "tag" | "rel" | "entity" | "graph" | "full">;
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

// ponytail: list_documents returns a folder-grouped shape. The
// chat-side card mirrors it as a list of folder sections, each
// collapsible past 3 docs. Mirrors the KbDocument type in
// backend/tool/kb/types.ts (kept local so tool-ui doesn't depend
// on the backend package).
export type ListDocumentsDoc = {
  id: string;
  title: string;
  status: "success" | "failed" | "parsing" | "pending";
  errorMessage: string | null;
  createdAt: string;
  totalPages: number;
  successPages: number;
  failedPages: number;
  parsingPages: number;
  pendingPages: number;
  totalChunks: number;
  successChunks: number;
  failedChunks: number;
  pendingChunks: number;
  parsingChunks: number;
};

export type ListDocumentsFolder = {
  id: string;
  name: string;
  documents: ListDocumentsDoc[];
};

export type ListDocResult = {
  content?: string;
  folders?: ListDocumentsFolder[];
  documents?: ListDocumentsDoc[];
  total?: number;
  page?: number;
  pageSize?: number;
  empty?: boolean;
};
