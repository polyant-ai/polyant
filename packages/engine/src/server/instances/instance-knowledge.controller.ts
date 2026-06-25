// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { extname, basename } from "path";
import { z } from "zod";
import { findInstanceOrFail } from "./instance-helpers.js";
import {
  createDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  hashContent,
  countDocuments,
  getKnowledgeForExport,
  listDocumentFilenames,
  resolveUniqueFilename,
} from "../../knowledge/index.js";
import { processDocument } from "../../knowledge/ingestion.js";
import { resolveEmbeddingContext } from "../../embeddings-gateway/index.js";
import { config } from "../../config.js";
import { RequirePermission, Permission } from "../../authz/index.js";

/** Maximum allowed document size in bytes (5 MB). */
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Map a filename extension to a stored MIME type (defaults to text/plain). */
function mimeForFilename(filename: string): string {
  const ext = extname(filename).replace(/^\./, "").toLowerCase();
  const mimeMap: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    html: "text/html",
  };
  return mimeMap[ext] ?? "text/plain";
}

/** Import bundle shape — produced by the export endpoint. */
const importBundleSchema = z.object({
  version: z.number().optional(),
  documents: z
    .array(
      z.object({
        filename: z.string().min(1),
        content: z.string().min(1),
      }),
    )
    .min(1),
});

@Controller("api/agents/:slug/knowledge")
export class InstanceKnowledgeController {
  /** GET /api/agents/:slug/knowledge — list documents (no rawContent) */
  @RequirePermission(Permission.KNOWLEDGE_READ)
  @Get()
  async list(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);

    const documents = await listDocuments(instance.slug);
    return {
      documents: documents.map((d) => ({
        id: d.id,
        filename: d.filename,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        source: d.source,
        status: d.status,
        chunkCount: d.chunkCount,
        errorMessage: d.errorMessage,
        createdAt: d.createdAt?.toISOString() ?? null,
        updatedAt: d.updatedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * GET /api/agents/:slug/knowledge/export — export every document (with raw
   * content) as a JSON bundle. Declared BEFORE the :docId route so "export" is
   * not captured as a document id.
   */
  @RequirePermission(Permission.KNOWLEDGE_READ)
  @Get("export")
  async export(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    const documents = await getKnowledgeForExport(instance.slug);
    return {
      version: 1,
      agentSlug: instance.slug,
      documents,
    };
  }

  /** GET /api/agents/:slug/knowledge/:docId — full document with rawContent */
  @RequirePermission(Permission.KNOWLEDGE_READ)
  @Get(":docId")
  async getById(@Param("slug") slug: string, @Param("docId") docId: string) {
    const instance = await findInstanceOrFail(slug);

    const doc = await getDocument(docId);
    if (!doc || doc.agentId !== instance.slug) {
      throw new NotFoundException(`Document "${docId}" not found`);
    }

    return {
      document: {
        id: doc.id,
        filename: doc.filename,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        rawContent: doc.rawContent,
        source: doc.source,
        status: doc.status,
        chunkCount: doc.chunkCount,
        errorMessage: doc.errorMessage,
        createdAt: doc.createdAt?.toISOString() ?? null,
        updatedAt: doc.updatedAt?.toISOString() ?? null,
      },
    };
  }

  /** POST /api/agents/:slug/knowledge — upload a document (text) */
  @RequirePermission(Permission.KNOWLEDGE_WRITE)
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async upload(
    @Param("slug") slug: string,
    @Body() body: { filename: string; content: string },
  ) {
    const instance = await findInstanceOrFail(slug);

    if (!instance.knowledgeEnabled) {
      throw new BadRequestException("Knowledge is not enabled for this instance");
    }

    if (!body.filename?.trim()) throw new BadRequestException("filename is required");
    if (!body.content?.trim()) throw new BadRequestException("content is required");

    // Enforce per-instance document cap before doing anything else.
    const maxDocs = config.knowledge.maxDocsPerInstance;
    const existingCount = await countDocuments(instance.slug);
    if (existingCount >= maxDocs) {
      throw new BadRequestException(
        `Knowledge document limit reached for this instance (cap: ${maxDocs})`,
      );
    }

    // Sanitize filename: strip directory components to prevent path traversal
    const sanitizedFilename = basename(body.filename.trim());
    if (!sanitizedFilename || sanitizedFilename !== body.filename.trim()) {
      throw new BadRequestException("Filename must not contain path separators or directory components");
    }

    const content = body.content.trim();

    // Enforce 5 MB file size limit
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `File size (${(sizeBytes / 1024 / 1024).toFixed(2)} MB) exceeds the 5 MB limit`,
      );
    }

    // Verify the embedding provider is configured before accepting the upload.
    // The gateway resolves provider-specific credentials (OpenAI key or Bedrock region).
    await resolveEmbeddingContext(instance.slug).catch((err: unknown) => {
      const message =
        err instanceof Error
          ? err.message
          : "Embedding provider is not configured for this instance.";
      throw new BadRequestException(message);
    });

    const doc = await createDocument({
      agentId: instance.slug,
      filename: sanitizedFilename,
      mimeType: mimeForFilename(sanitizedFilename),
      sizeBytes,
      rawContent: content,
      contentHash: hashContent(content),
      source: "upload",
    });

    // Ingest asynchronously
    processDocument(doc.id, instance.slug, content).catch((err) => {
      console.error(
        `[Knowledge] Ingestion failed for doc ${doc.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return {
      document: {
        id: doc.id,
        filename: doc.filename,
        status: doc.status,
      },
    };
  }

  /**
   * POST /api/agents/:slug/knowledge/import — bulk-import documents from a
   * JSON bundle (as produced by /export). Each document is re-embedded with the
   * agent's CURRENT embedder. Filename collisions are resolved by appending a
   * progressive suffix ("manuale.txt" → "manuale (1).txt") — never overwritten.
   * The whole bundle is validated up front so the import is all-or-nothing.
   */
  @RequirePermission(Permission.KNOWLEDGE_WRITE)
  @Post("import")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async import(@Param("slug") slug: string, @Body() body: unknown) {
    const instance = await findInstanceOrFail(slug);

    if (!instance.knowledgeEnabled) {
      throw new BadRequestException("Knowledge is not enabled for this instance");
    }

    const parsed = importBundleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid import bundle: ${parsed.error.issues[0]?.message ?? "malformed"}`);
    }

    // Verify the embedding provider is configured before importing anything.
    await resolveEmbeddingContext(instance.slug).catch((err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Embedding provider is not configured for this instance.";
      throw new BadRequestException(message);
    });

    // Validate + normalize every document up front (fail fast, no partial import).
    const prepared = parsed.data.documents.map((d, i) => {
      const sanitized = basename(d.filename.trim());
      if (!sanitized) {
        throw new BadRequestException(`Document ${i + 1}: filename must not be empty or a path component`);
      }
      const content = d.content.trim();
      if (!content) {
        throw new BadRequestException(`Document "${sanitized}": content must not be empty`);
      }
      const sizeBytes = Buffer.byteLength(content, "utf-8");
      if (sizeBytes > MAX_FILE_SIZE_BYTES) {
        throw new BadRequestException(
          `Document "${sanitized}" (${(sizeBytes / 1024 / 1024).toFixed(2)} MB) exceeds the 5 MB limit`,
        );
      }
      return { requestedName: sanitized, content, sizeBytes };
    });

    // Enforce the per-instance document cap across the whole batch.
    const maxDocs = config.knowledge.maxDocsPerInstance;
    const existing = await listDocumentFilenames(instance.slug);
    if (existing.length + prepared.length > maxDocs) {
      throw new BadRequestException(
        `Import would exceed the knowledge document limit for this instance (cap: ${maxDocs}, existing: ${existing.length}, importing: ${prepared.length})`,
      );
    }

    const taken = new Set(existing);
    const imported: { filename: string; renamedFrom?: string }[] = [];
    for (const doc of prepared) {
      const filename = resolveUniqueFilename(doc.requestedName, taken);
      taken.add(filename);

      const created = await createDocument({
        agentId: instance.slug,
        filename,
        mimeType: mimeForFilename(filename),
        sizeBytes: doc.sizeBytes,
        rawContent: doc.content,
        contentHash: hashContent(doc.content),
        source: "import",
      });

      // Re-embed with the instance's current embedder (fire-and-forget, like upload).
      processDocument(created.id, instance.slug, doc.content).catch((err) => {
        console.error(
          `[Knowledge] Import ingestion failed for doc ${created.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      imported.push(filename === doc.requestedName ? { filename } : { filename, renamedFrom: doc.requestedName });
    }

    return { imported: imported.length, documents: imported };
  }

  /** DELETE /api/agents/:slug/knowledge/:docId */
  @RequirePermission(Permission.KNOWLEDGE_WRITE)
  @Delete(":docId")
  async remove(@Param("slug") slug: string, @Param("docId") docId: string) {
    const instance = await findInstanceOrFail(slug);

    const doc = await getDocument(docId);
    if (!doc || doc.agentId !== instance.slug) {
      throw new NotFoundException(`Document "${docId}" not found`);
    }

    const deleted = await deleteDocument(docId);
    return { deleted };
  }
}
