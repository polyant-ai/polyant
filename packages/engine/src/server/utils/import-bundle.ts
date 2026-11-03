// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";
import { basename } from "path";
import { z } from "zod";
import { mimeForFilename } from "../../knowledge/mime-for-filename.js";
import { MAX_DOCUMENT_BYTES } from "../../knowledge/store.js";

/**
 * The UTF-8 size of `content`, refused when the knowledge store would refuse
 * it. An upload or an import takes a document as large as an agent's own writes
 * may grow one, so every exported document imports back. The wording is what
 * the panel shows.
 */
export function documentSizeWithinLimit(subject: string, content: string): number {
  const sizeBytes = Buffer.byteLength(content, "utf-8");
  if (sizeBytes > MAX_DOCUMENT_BYTES) {
    const mb = (bytes: number) => bytes / 1024 / 1024;
    throw new BadRequestException(
      `${subject} (${mb(sizeBytes).toFixed(2)} MB) exceeds the ${mb(MAX_DOCUMENT_BYTES)} MB limit`,
    );
  }
  return sizeBytes;
}

/** One document of a knowledge bundle, as `/export` writes it. */
export const bundleDocumentSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1),
  /** Absent in older bundles: those documents are on. */
  enabled: z.boolean().optional(),
});

/** A bundle document after validation: a plain filename, trimmed text, its size and stored type. */
export interface PreparedImportDocument<D> {
  requestedName: string;
  content: string;
  sizeBytes: number;
  mimeType: string;
  /** The document as the bundle carried it, for the fields only a caller's own schema knows. */
  document: D;
}

/**
 * Parse a knowledge bundle and check every document up front, so an import is
 * all-or-nothing: a bad document fails the whole bundle before anything is
 * stored. The wording of each refusal is what the panel shows.
 *
 * `documentSchema` lets a caller accept more per-document fields than the base
 * bundle (an agent's bundle also carries provenance); `mimeFor` lets it map
 * the stored type with a wider table than the text one.
 */
export function prepareImportDocuments<S extends z.ZodType<z.output<typeof bundleDocumentSchema>>>(
  body: unknown,
  options: { documentSchema?: S; mimeFor?: (filename: string) => string } = {},
): PreparedImportDocument<z.output<S>>[] {
  const schema = z.object({
    version: z.number().optional(),
    documents: z.array(options.documentSchema ?? bundleDocumentSchema).min(1),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(`Invalid import bundle: ${parsed.error.issues[0]?.message ?? "malformed"}`);
  }
  const mimeFor = options.mimeFor ?? mimeForFilename;
  return (parsed.data.documents as z.output<S>[]).map((d, i) => {
    const requestedName = basename(d.filename.trim());
    if (!requestedName) {
      throw new BadRequestException(`Document ${i + 1}: filename must not be empty or a path component`);
    }
    const content = d.content.trim();
    if (!content) throw new BadRequestException(`Document "${requestedName}": content must not be empty`);
    const sizeBytes = documentSizeWithinLimit(`Document "${requestedName}"`, content);
    return { requestedName, content, sizeBytes, mimeType: mimeFor(requestedName), document: d };
  });
}
