// ponytail: barrel re-export. The tools, helpers, types, and pgvector
// gate are all imported by the rest of the app via this single entry
// point (`@/backend/tool/kb` resolves to this file). Individual
// sub-modules stay private to the package.

export { isPgVectorAvailable, _resetPgVectorCache } from "./pgvector";
export { setKbToolUserId, thisUserId } from "./user-id";
export { formatSearchResult } from "./format";
export { searchKbTool } from "./search-kb";
export { searchGraphTool } from "./search-graph";
export {
  LIST_DOCUMENTS_STATUSES,
  listDocumentsTool,
  listKbDocumentsForUser,
  listKbFoldersForUser,
} from "./list-documents";
export type {
  KbSearchDocument,
  KbToolResult,
  ListDocumentsArgs,
  ListDocumentsResult,
} from "./types";
