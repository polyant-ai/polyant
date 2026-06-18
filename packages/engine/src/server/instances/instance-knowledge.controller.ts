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
import { findInstanceOrFail } from "./instance-helpers.js";
import {
  createDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  hashContent,
  countDocuments,
} from "../../knowledge/index.js";
import { processDocument } from "../../knowledge/ingestion.js";
import { resolveInstanceConfig } from "../../instances/config-resolver.js";
import { config } from "../../config.js";
import { RequirePermission, Permission } from "../../authz/index.js";

/** Maximum allowed document size in bytes (5 MB). */
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

@Controller("api/instances/:slug/knowledge")
export class InstanceKnowledgeController {
  /** GET /api/instances/:slug/knowledge — list documents (no rawContent) */
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

  /** GET /api/instances/:slug/knowledge/:docId — full document with rawContent */
  @RequirePermission(Permission.KNOWLEDGE_READ)
  @Get(":docId")
  async getById(@Param("slug") slug: string, @Param("docId") docId: string) {
    const instance = await findInstanceOrFail(slug);

    const doc = await getDocument(docId);
    if (!doc || doc.instanceId !== instance.slug) {
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

  /** POST /api/instances/:slug/knowledge — upload a document (text) */
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

    // Use path.extname for correct parsing of filenames with multiple dots
    // e.g. "document.v2.pdf" → ".pdf", "notes.md" → ".md"
    const ext = extname(sanitizedFilename).replace(/^\./, "").toLowerCase();
    const mimeMap: Record<string, string> = {
      md: "text/markdown",
      txt: "text/plain",
      html: "text/html",
    };

    // Resolve OpenAI API key (required for embedding generation)
    const instanceConfig = await resolveInstanceConfig(instance.slug);
    const openaiKey = instanceConfig.secrets["openai_api_key"];
    if (!openaiKey) {
      throw new BadRequestException(
        "OpenAI API key is not configured for this instance. " +
        "Knowledge ingestion requires an OpenAI key for embedding generation. " +
        "Set it via the instance secrets API.",
      );
    }

    const doc = await createDocument({
      instanceId: instance.slug,
      filename: sanitizedFilename,
      mimeType: mimeMap[ext] ?? "text/plain",
      sizeBytes,
      rawContent: content,
      contentHash: hashContent(content),
      source: "upload",
    });

    // Ingest asynchronously
    processDocument(doc.id, instance.slug, content, openaiKey).catch((err) => {
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

  /** DELETE /api/instances/:slug/knowledge/:docId */
  @RequirePermission(Permission.KNOWLEDGE_WRITE)
  @Delete(":docId")
  async remove(@Param("slug") slug: string, @Param("docId") docId: string) {
    const instance = await findInstanceOrFail(slug);

    const doc = await getDocument(docId);
    if (!doc || doc.instanceId !== instance.slug) {
      throw new NotFoundException(`Document "${docId}" not found`);
    }

    const deleted = await deleteDocument(docId);
    return { deleted };
  }
}
