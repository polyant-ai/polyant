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
/** A letter of the word an abbreviation dot may follow. */
const WORD_CHAR = /[a-zA-ZÀ-ÿ]/;

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
      // Scan back from the dot by index in `text`, never past the start of the current
      // sentence (`current` ends at `text[i]`). Matching a `$`-anchored regex against
      // the growing sentence re-read it from the start at every dot, which made a long
      // run of short dotted words quadratic.
      const sentenceStart = i - current.length + 1;
      let wordStart = i;
      while (wordStart > sentenceStart && WORD_CHAR.test(text[wordStart - 1])) wordStart--;
      if (wordStart < i) {
        const word = text.slice(wordStart, i).toLowerCase();
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
 *
 * No chunk is longer than `chunkSize` (for an `overlap` below `chunkSize - 2`),
 * whatever the punctuation: text extracted from PDFs, tables and CSV has no
 * blank lines and few sentence ends, and a chunk that grew with it could pass
 * the embedder's input limit and reach the model as thousands of tokens.
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

  for (const para of paragraphs) {
    const trimmed = para.trim();

    // If adding this paragraph stays within limit, accumulate
    if (buffer && buffer.length + trimmed.length + 2 <= chunkSize) {
      buffer += "\n\n" + trimmed;
      continue;
    }

    // Flush the buffer; its tail becomes the prefix of what follows.
    let overlapPrefix = "";
    if (buffer) {
      chunks.push({ content: buffer.trim(), metadata: { position } });
      position++;
      overlapPrefix = overlap > 0 ? buffer.slice(-overlap) : "";
    }

    const next = overlapPrefix ? overlapPrefix + "\n\n" + trimmed : trimmed;
    if (next.length <= chunkSize) {
      buffer = next;
      continue;
    }

    // Too long to start a chunk with: split by sentences.
    for (const sc of splitBySentences(trimmed, chunkSize, overlap, overlapPrefix)) {
      chunks.push({ content: sc, metadata: { position } });
      position++;
    }
    buffer = "";
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    chunks.push({ content: buffer.trim(), metadata: { position } });
  }

  return chunks;
}

/**
 * Split a long paragraph into chunks by sentence boundaries.
 * Overlap is applied as a prefix from the end of the previous chunk; `prefix`
 * is the overlap carried from the chunk before the paragraph.
 *
 * A "sentence" with no room left for the overlap is cut first at the last
 * whitespace before that room, or at the room itself when there is no
 * whitespace in its second half, so no piece can push a chunk past `chunkSize`.
 */
function splitBySentences(
  text: string,
  chunkSize: number,
  overlap: number,
  prefix: string,
): string[] {
  const room = Math.max(1, chunkSize - overlap - 2);
  const pieces: string[] = [];
  for (const sentence of splitSentences(text)) {
    let rest = sentence;
    while (rest.length > room) {
      const at = lastWhitespaceBefore(rest, room);
      const cut = at > room / 2 ? at + 1 : room;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) pieces.push(rest);
  }

  const chunks: string[] = [];
  let buffer = prefix ? prefix + "\n\n" : "";

  for (const piece of pieces) {
    if (buffer.length + piece.length <= chunkSize) {
      buffer += piece;
    } else {
      if (buffer.trim()) chunks.push(buffer.trim());

      // Calculate overlap prefix from the end of the flushed chunk
      const overlapText = overlap > 0 ? buffer.slice(-overlap) : "";

      // Start new buffer with overlap prefix + new piece
      buffer = overlapText + piece;
    }
  }

  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

/** Index of the last whitespace character before `limit`, or -1. */
function lastWhitespaceBefore(text: string, limit: number): number {
  for (let i = limit - 1; i >= 0; i--) {
    if (/\s/.test(text[i])) return i;
  }
  return -1;
}
