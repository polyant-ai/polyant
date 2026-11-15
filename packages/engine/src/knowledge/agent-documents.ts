// SPDX-License-Identifier: AGPL-3.0-or-later

import { basename } from "path";
import { AgentRequestRefusedError } from "../instances/agent-refusal.js";
import type { Instance } from "../instances/store.js";
import { resolveEmbeddingContext } from "../embeddings-gateway/index.js";
import { createLogger } from "../utils/create-logger.js";
import { resolveKnowledgeDocCap } from "./doc-cap.js";
import { processDocument } from "./ingestion.js";
import { mimeForFilename } from "./mime-for-filename.js";
import { countDocuments, createDocument, hashContent, MAX_DOCUMENT_BYTES } from "./store.js";

const log = createLogger();

/**
 * Add a text document to an agent's knowledge and start indexing it in the
 * background. The one path for every caller that adds a document from text,
 * so every caller refuses the same inputs: the
 * knowledge switch off, the document cap reached, a filename with directory
 * components, an oversized body, an agent with no embedding provider.
 */
export async function addAgentKnowledgeText(
  instance: Pick<Instance, "slug" | "knowledgeEnabled">,
  input: { filename?: string; content?: string },
) {
  if (!instance.knowledgeEnabled) {
    throw new AgentRequestRefusedError("Knowledge is not enabled for this instance", "invalid");
  }
  if (!input.filename?.trim()) throw new AgentRequestRefusedError("filename is required", "invalid");
  if (!input.content?.trim()) throw new AgentRequestRefusedError("content is required", "invalid");

  // The cap first: it is the organization's entitlement, resolved in one place.
  const maxDocs = await resolveKnowledgeDocCap(instance.slug);
  if ((await countDocuments(instance.slug)) >= maxDocs) {
    throw new AgentRequestRefusedError(`Knowledge document limit reached for this instance (cap: ${maxDocs})`, "invalid");
  }

  // No directory components: the filename is shown and exported as given.
  const filename = basename(input.filename.trim());
  if (!filename || filename !== input.filename.trim()) {
    throw new AgentRequestRefusedError("Filename must not contain path separators or directory components", "invalid");
  }

  const content = input.content.trim();
  const sizeBytes = Buffer.byteLength(content, "utf-8");
  if (sizeBytes > MAX_DOCUMENT_BYTES) {
    const mb = (bytes: number) => bytes / 1024 / 1024;
    throw new AgentRequestRefusedError(
      `File size (${mb(sizeBytes).toFixed(2)} MB) exceeds the ${mb(MAX_DOCUMENT_BYTES)} MB limit`,
      "invalid",
    );
  }

  // The embedding provider must be usable before the document is accepted.
  try {
    await resolveEmbeddingContext(instance.slug);
  } catch (err) {
    throw new AgentRequestRefusedError(
      err instanceof Error ? err.message : "Embedding provider is not configured for this instance.",
      "invalid",
      "missing_provider_key",
    );
  }

  const doc = await createDocument({
    instanceId: instance.slug,
    filename,
    mimeType: mimeForFilename(filename),
    sizeBytes,
    rawContent: content,
    contentHash: hashContent(content),
    source: "upload",
  });
  processDocument(doc.id, instance.slug, content).catch((err) => {
    log.error("knowledge", `Ingestion failed for doc ${doc.id}`, err);
  });
  return doc;
}
