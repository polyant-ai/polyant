import { describe, it, expect } from "vitest";
import { vectorColumnValues } from "./dim-columns.js";

describe("vectorColumnValues", () => {
  it("routes 1024 vectors to embedding_1024 and nulls legacy", () => {
    expect(vectorColumnValues(1024, [1, 2, 3])).toEqual({ embedding: null, embedding1024: [1, 2, 3] });
  });
  it("routes 1536 vectors to legacy column and nulls 1024", () => {
    expect(vectorColumnValues(1536, [1, 2, 3])).toEqual({ embedding: [1, 2, 3], embedding1024: null });
  });
});
