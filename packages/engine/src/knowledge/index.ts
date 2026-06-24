// SPDX-License-Identifier: AGPL-3.0-or-later

export { searchKnowledge } from "./search.js";
export type { KnowledgeSearchResult } from "./search.js";

export { processDocument } from "./ingestion.js";

export {
  createDocument,
  updateDocumentStatus,
  listDocuments,
  getDocument,
  deleteDocument,
  deleteAllKnowledgeForInstance,
  countChunks,
  countDocuments,
  hashContent,
  getKnowledgeForExport,
  listDocumentFilenames,
  resolveUniqueFilename,
} from "./store.js";
export type { KnowledgeDocument, ExportedDocument } from "./store.js";

export { chunkText } from "./chunker.js";
