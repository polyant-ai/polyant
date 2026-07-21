// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { stripReasoningTags } from "./strip-reasoning-tags.js";

describe("stripReasoningTags", () => {
  it("removes the leaked reasoning block from the exact reported message, keeping the rest", () => {
    const reported =
      "Perfetto, Flavio! Un consulente può richiamarti <callbackWindow>. A che ora ti è più comodo? " +
      "(es. 11, 15:30, ecc.)<reasoning>Now wait for hour then validate.</reasoning>" +
      "Perfetto, Flavio! Un consulente può richiamarti oggi, tra le 10 e le 20. " +
      "A che ora ti è più comodo? (es. 11, 15:30, ecc.)";

    const out = stripReasoningTags(reported);

    // the reasoning block and its inner text are gone
    expect(out).not.toContain("<reasoning>");
    expect(out).not.toContain("Now wait for hour");
    // scope: the prompt placeholder and the duplication are NOT the framework's job
    expect(out).toContain("<callbackWindow>");
    expect(out.match(/Perfetto, Flavio!/g)).toHaveLength(2);
  });

  it("removes think and thinking blocks", () => {
    expect(stripReasoningTags("a<think>x</think>b")).toBe("ab");
    expect(stripReasoningTags("a<thinking>x</thinking>b")).toBe("ab");
  });

  it("is case-insensitive and tolerates attributes", () => {
    expect(stripReasoningTags("a<THINK>x</think>b")).toBe("ab");
    expect(stripReasoningTags('a<reasoning foo="bar">x</reasoning>b')).toBe("ab");
  });

  it("strips an orphan (unclosed) tag but keeps the surrounding text", () => {
    expect(stripReasoningTags("before <think> after")).toBe("before after");
    expect(stripReasoningTags("done </reasoning>")).toBe("done");
  });

  it("does not touch generics, comparisons, or unrelated tags", () => {
    expect(stripReasoningTags("const x: Array<string> = []")).toBe("const x: Array<string> = []");
    expect(stripReasoningTags("if x < 5 and y > 3")).toBe("if x < 5 and y > 3");
    expect(stripReasoningTags("a <div>hello</div> b")).toBe("a <div>hello</div> b");
  });

  it("passes clean text through unchanged", () => {
    expect(stripReasoningTags("Ciao, come posso aiutarti?")).toBe("Ciao, come posso aiutarti?");
  });

  it("is idempotent", () => {
    const once = stripReasoningTags("a<reasoning>secret</reasoning>b<think>more</think>c");
    expect(stripReasoningTags(once)).toBe(once);
    expect(once).toBe("abc");
  });
});
