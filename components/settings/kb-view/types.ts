export type KbStatus = "pending" | "parsing" | "success" | "failed";

export type KbDocument = {
  id: string;
  title: string;
  status: KbStatus;
  errorMessage: string | null;
  contentType: string;
  attachmentId: string | null;
  attachmentUrl: string | null;
  pages?: Array<{
    pageIndex: number;
    imageUrl: string;
    markdown: string;
    referenceText?: string;
    errorMessage?: string;
    status?: "pending" | "parsing" | "success" | "failed";
  }>;
  createdAt: string;
  updatedAt: string;
  totalChunks?: number;
  successChunks?: number;
  embeddingPendingChunks?: number;
  failedChunks?: number;
  pendingChunks?: number;
  parsingChunks?: number;
  entityCount?: number;
  relationshipCount?: number;
  totalPages?: number;
  failedPages?: number;
  pendingPages?: number;
  parsingPages?: number;
};

export type KbFolder = { id: string; name: string; docCount?: number };

export type KbResponse = {
  groups: Array<{ folder: KbFolder; documents: KbDocument[] }>;
};

export type KbChunkPreviewLocal = {
  ordinal: number;
  content: string;
  entities: Array<{ name: string; type: string; description: string }>;
  relationships: Array<{ source: string; target: string; relation: string; description: string }>;
  themes: string[];
  status: "pending" | "parsing" | "success" | "failed";
  errorMessage: string | null;
  // ponytail: mirrors lib/kb/queries.ts KbChunkPreview. Used by the
  // doc-detail badge to detect status='success' chunks that haven't
  // received a pgvector embedding yet ("Embedding" intermediate state).
  hasEmbedding: boolean;
};

export type KbDocDetail = {
  doc: KbDocument & { folderId: string; contentHash: string };
  chunks: KbChunkPreviewLocal[];
};
