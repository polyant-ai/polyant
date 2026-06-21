// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  vector,
  pgEnum,
  check,
} from "drizzle-orm/pg-core";

export const knowledgeDocumentStatusEnum = pgEnum("knowledge_document_status", [
  "uploading",
  "processing",
  "ready",
  "error",
]);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    rawContent: text("raw_content").notNull().default(""),
    contentHash: text("content_hash").notNull().default(""),
    source: text("source").notNull().default("upload"), // "upload" | "agent"
    status: knowledgeDocumentStatusEnum("status").notNull().default("uploading"),
    chunkCount: integer("chunk_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_knowledge_docs_instance_id").on(table.agentId),
    index("idx_knowledge_docs_status").on(table.status),
    index("idx_knowledge_docs_instance_hash").on(table.agentId, table.contentHash),
    uniqueIndex("knowledge_docs_instance_filename_uniq").on(table.agentId, table.filename),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    agentId: text("agent_id").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    embedding1024: vector("embedding_1024", { dimensions: 1024 }),
    embeddingProvider: text("embedding_provider"),
    chunkIndex: integer("chunk_index").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_knowledge_chunks_instance_id").on(table.agentId),
    index("idx_knowledge_chunks_document_id").on(table.documentId),
    check(
      "knowledge_chunks_embedding_xor",
      sql`(${table.embedding} IS NULL) <> (${table.embedding1024} IS NULL)`,
    ),
  ],
);
