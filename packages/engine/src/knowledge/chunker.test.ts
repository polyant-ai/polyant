// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { chunkText, splitSentences, MAX_CHUNKER_INPUT_LENGTH } from "./chunker.js";

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------
describe("splitSentences", () => {
  it("splits on standard sentence endings", () => {
    const result = splitSentences("Hello world. How are you? Fine!");
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("Hello world.");
    expect(result[1]).toContain("How are you?");
    expect(result[2]).toContain("Fine!");
  });

  it("keeps Italian abbreviations intact (Dr., Dott., Prof., Sig.)", () => {
    const text = "Il Dr. Rossi ha visitato il paziente. La diagnosi è positiva.";
    const result = splitSentences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Dr. Rossi");
    expect(result[1]).toContain("La diagnosi");
  });

  it("handles Dott. abbreviation", () => {
    const text = "Il Dott. Bianchi prescrive la terapia. Il paziente accetta.";
    const result = splitSentences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Dott. Bianchi");
  });

  it("handles Prof. abbreviation", () => {
    const text = "Il Prof. Verdi insegna matematica. Gli studenti lo apprezzano.";
    const result = splitSentences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Prof. Verdi");
  });

  it("handles Sig. and Sig.ra abbreviations", () => {
    const text = "Il Sig. Neri e la Sig.ra Neri sono arrivati. Benvenuti.";
    const result = splitSentences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Sig. Neri");
    expect(result[0]).toContain("Sig.ra Neri");
  });

  it("handles Ing. and Avv. abbreviations", () => {
    const text = "L'Ing. Conti e l'Avv. Russo lavorano insieme. Sono colleghi.";
    const result = splitSentences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Ing. Conti");
    expect(result[0]).toContain("Avv. Russo");
  });

  it("handles ellipsis without splitting", () => {
    const text = "Il paziente ha detto... non so cosa fare. Il dottore lo ha rassicurato.";
    const result = splitSentences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("...");
    expect(result[0]).toContain("non so cosa fare.");
  });

  it("handles multiple abbreviations in sequence", () => {
    const text = "Il Dr. Rossi e il Prof. Bianchi si sono consultati. La diagnosi è chiara.";
    const result = splitSentences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Dr. Rossi");
    expect(result[0]).toContain("Prof. Bianchi");
  });

  it("returns single sentence for text without sentence endings", () => {
    const text = "just some text without punctuation";
    const result = splitSentences(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("just some text without punctuation");
  });

  it("handles English abbreviations (Mr., Mrs., etc.)", () => {
    const text = "Mr. Smith visited Mrs. Jones. They discussed the plan.";
    const result = splitSentences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Mr. Smith");
    expect(result[0]).toContain("Mrs. Jones");
  });
});

// ---------------------------------------------------------------------------
// chunkText – basic behavior
// ---------------------------------------------------------------------------
describe("chunkText", () => {
  it("returns empty array for empty text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const result = chunkText("Hello world.", { chunkSize: 100, overlap: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello world.");
    expect(result[0].metadata.position).toBe(0);
  });

  it("splits into multiple chunks when text exceeds chunkSize", () => {
    const para1 = "A".repeat(80);
    const para2 = "B".repeat(80);
    const text = para1 + "\n\n" + para2;
    const result = chunkText(text, { chunkSize: 100, overlap: 0 });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].content).toBe(para1);
    expect(result[1].content).toBe(para2);
  });

  it("accumulates small paragraphs into one chunk", () => {
    const text = "Small para one.\n\nSmall para two.\n\nSmall para three.";
    const result = chunkText(text, { chunkSize: 500, overlap: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Small para one.");
    expect(result[0].content).toContain("Small para three.");
  });

  it("assigns sequential position metadata", () => {
    const para = "X".repeat(60);
    const text = [para, para, para].join("\n\n");
    const result = chunkText(text, { chunkSize: 80, overlap: 0 });
    result.forEach((chunk, i) => {
      expect(chunk.metadata.position).toBe(i);
    });
  });
});

// ---------------------------------------------------------------------------
// chunkText – overlap correctness
// ---------------------------------------------------------------------------
describe("chunkText overlap", () => {
  it("next chunk starts with the tail of the previous chunk (paragraph-level)", () => {
    // Two paragraphs that individually fit but together exceed chunkSize
    const para1 = "First paragraph content here.";
    const para2 = "Second paragraph is separate.";
    const text = para1 + "\n\n" + para2;

    const overlapSize = 10;
    const result = chunkText(text, { chunkSize: 35, overlap: overlapSize });

    expect(result.length).toBeGreaterThanOrEqual(2);

    // The tail of chunk 0 should appear as a prefix in chunk 1
    const chunk0 = result[0].content;
    const tailOfChunk0 = chunk0.slice(-overlapSize);
    expect(result[1].content.startsWith(tailOfChunk0)).toBe(true);
  });

  it("overlap does not cause content duplication in the same chunk", () => {
    const para1 = "A".repeat(50);
    const para2 = "B".repeat(50);
    const para3 = "C".repeat(50);
    const text = [para1, para2, para3].join("\n\n");

    const result = chunkText(text, { chunkSize: 60, overlap: 10 });

    // Each chunk should NOT contain the full content of the previous chunk
    // (the old bug appended overlap + new content after flushing, causing duplication)
    for (const chunk of result) {
      // No chunk should be larger than chunkSize + overlap + small separator overhead
      expect(chunk.content.length).toBeLessThanOrEqual(60 + 10 + 10);
    }
  });

  it("with overlap=0, chunks have no shared content", () => {
    const para1 = "Alpha paragraph.";
    const para2 = "Beta paragraph.";
    const text = para1 + "\n\n" + para2;

    const result = chunkText(text, { chunkSize: 20, overlap: 0 });
    expect(result.length).toBe(2);
    expect(result[0].content).toBe(para1);
    expect(result[1].content).toBe(para2);
  });

  it("overlap in sentence-level splitting works correctly", () => {
    // A single very long paragraph that must be split by sentences
    const s1 = "First sentence here. ";
    const s2 = "Second sentence here. ";
    const s3 = "Third sentence here.";
    const longPara = s1 + s2 + s3;

    const result = chunkText(longPara, { chunkSize: 45, overlap: 15 });
    expect(result.length).toBeGreaterThanOrEqual(2);

    // Verify overlap: the end of chunk 0 content should overlap with the start of chunk 1
    if (result.length >= 2) {
      const chunk0 = result[0].content;
      const chunk1 = result[1].content;
      // Find the common substring: chunk1 should contain some text from the end of chunk0
      const overlapText = chunk0.slice(-15);
      expect(chunk1).toContain(overlapText);
    }
  });
});

// ---------------------------------------------------------------------------
// chunkText – sentence splitting for large paragraphs
// ---------------------------------------------------------------------------
describe("chunkText sentence splitting", () => {
  it("splits oversized paragraphs by sentences", () => {
    const longPara =
      "This is sentence one. This is sentence two. This is sentence three. This is sentence four.";
    // chunkSize smaller than the paragraph forces sentence splitting
    const result = chunkText(longPara, { chunkSize: 50, overlap: 0 });
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("handles abbreviations in sentence splitting without false breaks", () => {
    const longPara =
      "Il Dr. Rossi ha prescritto una terapia innovativa per il paziente. " +
      "Il Dott. Bianchi ha confermato la diagnosi iniziale del collega. " +
      "La Sig.ra Verdi ha seguito le indicazioni alla lettera. " +
      "I risultati sono stati eccellenti e il recupero completo.";

    const result = chunkText(longPara, { chunkSize: 150, overlap: 20 });

    // Verify no chunk starts mid-abbreviation (e.g., should not start with "Rossi ha...")
    for (const chunk of result) {
      expect(chunk.content).not.toMatch(/^Rossi/);
      expect(chunk.content).not.toMatch(/^Bianchi/);
      expect(chunk.content).not.toMatch(/^ra Verdi/);
    }
  });
});

// ---------------------------------------------------------------------------
// Input length cap (CodeQL js/loop-bound-injection — #16)
// ---------------------------------------------------------------------------
describe("chunker input length cap", () => {
  it("chunkText throws RangeError when input exceeds MAX_CHUNKER_INPUT_LENGTH", () => {
    // We don't actually allocate a 10MB+1 string — we synthesise a string of
    // that length via String.prototype.repeat on a single char (cheap).
    const oversized = "a".repeat(MAX_CHUNKER_INPUT_LENGTH + 1);
    expect(() => chunkText(oversized)).toThrow(RangeError);
  });

  it("splitSentences throws RangeError when input exceeds MAX_CHUNKER_INPUT_LENGTH", () => {
    const oversized = "a".repeat(MAX_CHUNKER_INPUT_LENGTH + 1);
    expect(() => splitSentences(oversized)).toThrow(RangeError);
  });
});
