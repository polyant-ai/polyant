// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KnowledgeDocument, KnowledgeDocumentDetail } from "@/lib/api-types";

export function makeKnowledgeDocument(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: "d1",
    filename: "guide.md",
    mimeType: "text/markdown",
    sizeBytes: 10,
    source: "upload",
    status: "ready",
    chunkCount: 1,
    errorMessage: null,
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeKnowledgeDocumentDetail(overrides: Partial<KnowledgeDocumentDetail> = {}): KnowledgeDocumentDetail {
  return { ...makeKnowledgeDocument(), rawContent: "# Guide body", ...overrides };
}

/** One page of the document list, in the shape `api.knowledge.list` resolves. */
export function makeKnowledgePage(
  documents: KnowledgeDocument[],
  overrides: { nextOffset?: number | null; total?: number; failed?: number } = {},
) {
  return {
    documents,
    total: documents.length,
    failed: documents.filter((d) => d.status === "error").length,
    ...overrides,
  };
}
