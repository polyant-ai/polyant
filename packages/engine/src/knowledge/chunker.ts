// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Text chunking for knowledge base documents.
 * Splits text into overlapping chunks suitable for embedding.
 */

export interface Chunk {
  content: string;
  metadata: { position: number; section?: string };
}

/** Default target size in characters (~500 tokens ≈ 2000 chars). */
const DEFAULT_CHUNK_SIZE = 2000;

/** Overlap in characters (~50 tokens ≈ 200 chars). */
const DEFAULT_OVERLAP = 200;

/**
 * Hard cap on the input text length accepted by the chunker. Documents come
 * from user uploads — the store layer enforces MAX_DOCUMENT_BYTES (10MB) on
 * the binary, but the extracted text could in principle be larger after
 * decoding. This independent ceiling at the chunker entry point prevents
 * loop-bound injection (CodeQL js/loop-bound-injection) on the
 * sentence-splitter while loop.
 */
export const MAX_CHUNKER_INPUT_LENGTH = 10 * 1024 * 1024;

/**
 * Common abbreviations that should NOT trigger sentence splits.
 * Covers Italian titles, professional titles, and common abbreviations.
 */
const ABBREVIATIONS = new Set([
  "dr",
  "dott",
  "dott.ssa",
  "prof",
  "prof.ssa",
  "sig",
  "sig.ra",
  "sig.na",
  "ing",
  "avv",
  "geom",
  "rag",
  "arch",
  "on",
  "ill",
  "spett",
  "egr",
  "preg",
  "gen",
  "col",
  "cap",
  "sgt",
  "mr",
  "mrs",
  "ms",
  "jr",
  "sr",
  "st",
  "vs",
  "etc",
  "fig",
  "es",
  "vol",
  "ed",
  "rev",
  "tel",
  "fax",
  "pag",
  "n",
  "nr",
  "art",
  "c.a",
  "p.es",
]);

/**
 * Split text into sentences, respecting abbreviations and ellipsis.
 *
 * Strategy: split on `.` `!` `?` followed by whitespace + uppercase letter (or end),
 * but skip known abbreviations and ellipsis (`...`).
 */
export function splitSentences(text: string): string[] {
  if (text.length > MAX_CHUNKER_INPUT_LENGTH) {
    throw new RangeError(
      `splitSentences input exceeds ${MAX_CHUNKER_INPUT_LENGTH} chars (got ${text.length})`,
    );
  }
  const sentences: string[] = [];
  let current = "";

  // Regex to find potential sentence-ending punctuation
  // We iterate character by character for precise abbreviation handling
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    current += ch;

    if (ch === "!" || ch === "?") {
      // Consume trailing whitespace
      const rest = text.slice(i + 1);
      const wsMatch = rest.match(/^\s+/);
      if (wsMatch) {
        current += wsMatch[0];
        i += wsMatch[0].length;
      }
      // Flush if next char is uppercase, end of string, or next sentence
      const nextChar = text[i + 1];
      if (!nextChar || /[A-ZÀ-ÖØ-Þ]/.test(nextChar)) {
        sentences.push(current);
        current = "";
      }
      i++;
      continue;
    }

    if (ch === ".") {
      // Check for ellipsis: three or more dots
      if (text[i + 1] === "." && text[i + 2] === ".") {
        // Consume all dots in the ellipsis
        while (text[i + 1] === ".") {
          i++;
          current += text[i];
        }
        i++;
        continue;
      }

      // Check if this dot is part of an abbreviation
      // Look back to find the word before the dot
      const beforeDot = current.slice(0, -1); // everything before the dot
      const wordMatch = beforeDot.match(/([a-zA-ZÀ-ÿ]+)$/);
      if (wordMatch) {
        const word = wordMatch[1].toLowerCase();
        // Check if the word (or word with dots, like "sig.ra") is an abbreviation
        // Also check compound forms: the full token including any dots
        const dotSuffix = text.slice(i + 1).match(/^([a-zA-Z]+)\./);
        if (dotSuffix) {
          const compound = word + "." + dotSuffix[1].toLowerCase();
          if (ABBREVIATIONS.has(compound)) {
            // Consume the compound part (e.g., ".ra" in "Sig.ra")
            current += dotSuffix[1] + ".";
            i += dotSuffix[0].length;
            i++;
            continue;
          }
        }

        if (ABBREVIATIONS.has(word)) {
          i++;
          continue;
        }
      }

      // Consume trailing whitespace after the dot
      const rest = text.slice(i + 1);
      const wsMatch = rest.match(/^\s+/);
      if (wsMatch) {
        current += wsMatch[0];
        i += wsMatch[0].length;
      }

      // It's a sentence boundary if followed by uppercase, end of string, or nothing
      const nextChar = text[i + 1];
      if (!nextChar || /[A-ZÀ-ÖØ-Þ]/.test(nextChar)) {
        sentences.push(current);
        current = "";
      }
      i++;
      continue;
    }

    i++;
  }

  if (current.trim()) {
    sentences.push(current);
  }

  return sentences;
}

/**
 * Split text into chunks by paragraphs, then by sentences if paragraphs are too large.
 * Returns chunks with positional metadata.
 *
 * Overlap logic: the last `overlap` characters of the previous chunk are used as
 * a prefix for the next chunk, ensuring context continuity.
 */
export function chunkText(
  text: string,
  opts: { chunkSize?: number; overlap?: number } = {},
): Chunk[] {
  if (text.length > MAX_CHUNKER_INPUT_LENGTH) {
    throw new RangeError(
      `chunkText input exceeds ${MAX_CHUNKER_INPUT_LENGTH} chars (got ${text.length})`,
    );
  }
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  if (!text.trim()) return [];

  // Split into paragraphs (double newline)
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());

  const chunks: Chunk[] = [];
  let buffer = "";
  let position = 0;
  let overlapPrefix = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();

    // If adding this paragraph stays within limit, accumulate
    if (buffer && buffer.length + trimmed.length + 2 <= chunkSize) {
      buffer += "\n\n" + trimmed;
      continue;
    }

    // If buffer is non-empty and adding would exceed, flush buffer
    if (buffer) {
      chunks.push({ content: buffer.trim(), metadata: { position } });
      position++;

      // Calculate overlap prefix from the end of the flushed chunk
      if (overlap > 0 && buffer.length > overlap) {
        overlapPrefix = buffer.slice(-overlap);
      } else if (overlap > 0) {
        overlapPrefix = buffer;
      } else {
        overlapPrefix = "";
      }

      // Start new buffer with overlap prefix + new paragraph
      buffer = overlapPrefix ? overlapPrefix + "\n\n" + trimmed : trimmed;
      continue;
    }

    // If single paragraph exceeds chunk size, split by sentences
    if (trimmed.length > chunkSize) {
      const sentenceChunks = splitBySentences(trimmed, chunkSize, overlap);
      for (const sc of sentenceChunks) {
        chunks.push({ content: sc, metadata: { position } });
        position++;
      }
      buffer = "";
      overlapPrefix = "";
      continue;
    }

    buffer = overlapPrefix ? overlapPrefix + "\n\n" + trimmed : trimmed;
    overlapPrefix = "";
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    chunks.push({ content: buffer.trim(), metadata: { position } });
  }

  return chunks;
}

/**
 * Split a long paragraph into chunks by sentence boundaries.
 * Overlap is applied as a prefix from the end of the previous chunk.
 */
function splitBySentences(
  text: string,
  chunkSize: number,
  overlap: number,
): string[] {
  const sentences = splitSentences(text);

  const chunks: string[] = [];
  let buffer = "";

  for (const sentence of sentences) {
    if (buffer.length + sentence.length <= chunkSize) {
      buffer += sentence;
    } else {
      if (buffer.trim()) chunks.push(buffer.trim());

      // Calculate overlap prefix from the end of the flushed chunk
      const overlapText =
        overlap > 0 && buffer.length > overlap
          ? buffer.slice(-overlap)
          : overlap > 0
            ? buffer
            : "";

      // Start new buffer with overlap prefix + new sentence
      buffer = overlapText ? overlapText + sentence : sentence;
    }
  }

  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}
