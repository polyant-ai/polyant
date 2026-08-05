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

  // Cases below are verbatim shapes observed leaking into persisted replies:
  // Qwen leaks ChatML tokens on Bedrock, gpt-oss leaks harmony `to=functions.`.
  it("strips a leaked ChatML pipe token (im_start) but keeps the reply", () => {
    const reported =
      'In quale zona preferisce effettuare la visita?\n<|im_start|>\n{"name": "searchAppointmentSlots"}';
    const out = stripReasoningTags(reported);
    expect(out).not.toContain("<|im_start|>");
    expect(out).toContain("In quale zona preferisce effettuare la visita?");
  });

  it("strips a paired ChatML tool_call block including its JSON payload", () => {
    const out = stripReasoningTags(
      'ok\n<|tool_call|>\n{"name":"clinicInfo","arguments":{"city":"Ovada"}}\n</|tool_call|>',
    );
    expect(out).toBe("ok");
  });

  it("strips the plain-text harmony to=functions call syntax (no angle brackets)", () => {
    const out = stripReasoningTags(
      "Ho appena registrato la richiamata.\n\nto=functions.innova__registraRichiamata",
    );
    expect(out).not.toContain("to=functions");
    expect(out).toContain("Ho appena registrato la richiamata.");
  });

  it("does not strip ordinary pipes or an unpaired '<|' without a closing '|>'", () => {
    expect(stripReasoningTags("| a | b |\n|---|---|")).toBe("| a | b |\n|---|---|");
    expect(stripReasoningTags("use a <| b as a guard")).toBe("use a <| b as a guard");
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
