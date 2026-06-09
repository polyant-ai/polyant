import { describe, it, expect } from "vitest";
import { assertDimSupported, SUPPORTED_DIMS, DEFAULT_EMBEDDING_DIM } from "./config.js";

describe("assertDimSupported", () => {
  it("accepts supported dims", () => {
    expect(() => assertDimSupported("openai", 1536)).not.toThrow();
    expect(() => assertDimSupported("openai", 1024)).not.toThrow();
    expect(() => assertDimSupported("bedrock", 1024)).not.toThrow();
  });
  it("rejects 1536 on bedrock", () => {
    expect(() => assertDimSupported("bedrock", 1536)).toThrow(/does not support 1536/);
  });
  it("defaults new instances to 1024", () => {
    expect(DEFAULT_EMBEDDING_DIM).toBe(1024);
    expect(SUPPORTED_DIMS.bedrock).toEqual([1024]);
  });
});
