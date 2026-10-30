// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { applyIntermediateTextPolicy, replyTextFor, textDeltas } from "./intermediate-text.js";

/** A two-step turn: a greeting written alongside a tool call, then the answer. */
function toolTurn(): unknown[] {
  return [
    { type: "start-step" },
    { type: "text-start", id: "a" },
    { type: "text-delta", id: "a", text: "Hello, " },
    { type: "text-delta", id: "a", text: "let me check." },
    { type: "text-end", id: "a" },
    { type: "tool-input-start", id: "t1", toolName: "lookup" },
    { type: "tool-call", toolCallId: "t1", toolName: "lookup", input: {} },
    { type: "tool-result", toolCallId: "t1", output: { ok: true } },
    { type: "finish-step", finishReason: "tool-calls" },
    { type: "start-step" },
    { type: "text-start", id: "b" },
    { type: "text-delta", id: "b", text: "It is open." },
    { type: "text-end", id: "b" },
    { type: "finish-step", finishReason: "stop" },
    { type: "finish" },
  ];
}

async function* from(parts: unknown[]): AsyncGenerator<unknown> {
  yield* parts;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

async function streamedText(policy: Parameters<typeof applyIntermediateTextPolicy>[1]): Promise<string> {
  return (await collect(textDeltas(applyIntermediateTextPolicy(from(toolTurn()), policy)))).join("");
}

describe("replyTextFor", () => {
  const steps = [{ text: "Hello, let me check." }, { text: "" }, { text: "It is open." }];

  it("keeps the last step's text when the policy is unset, discard or progress", () => {
    for (const policy of [undefined, "discard", "progress"] as const) {
      expect(replyTextFor(policy, "It is open.", steps)).toBe("It is open.");
    }
  });

  it("joins every step's text, skipping empty steps, under reply", () => {
    expect(replyTextFor("reply", "It is open.", steps)).toBe("Hello, let me check.\n\nIt is open.");
  });
});

describe("applyIntermediateTextPolicy", () => {
  it("streams every step's text when the policy is unset or progress, as before the policy", async () => {
    expect(await streamedText(undefined)).toBe("Hello, let me check.It is open.");
    expect(await streamedText("progress")).toBe("Hello, let me check.It is open.");
  });

  it("drops the text of a step that called a tool under discard", async () => {
    expect(await streamedText("discard")).toBe("It is open.");
  });

  it("keeps tool and step events under discard, so live tool activity still flows", async () => {
    const types = (await collect(applyIntermediateTextPolicy(from(toolTurn()), "discard"))).map(
      (part) => (part as { type: string }).type,
    );
    expect(types.filter((t) => t === "tool-call")).toHaveLength(1);
    expect(types.filter((t) => t === "finish-step")).toHaveLength(2);
    expect(types.at(-1)).toBe("finish");
  });

  it("drops text that a step writes after its tool call under discard", async () => {
    const parts = [
      { type: "start-step" },
      { type: "tool-call", toolCallId: "t1", toolName: "lookup", input: {} },
      { type: "text-delta", id: "a", text: "late note" },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "start-step" },
      { type: "text-delta", id: "b", text: "Answer." },
      { type: "finish-step", finishReason: "stop" },
    ];
    expect((await collect(textDeltas(applyIntermediateTextPolicy(from(parts), "discard")))).join("")).toBe("Answer.");
  });

  it("delivers held text when the stream ends before its step closes under discard", async () => {
    const parts = [{ type: "start-step" }, { type: "text-delta", id: "a", text: "Partial answer" }];
    expect((await collect(textDeltas(applyIntermediateTextPolicy(from(parts), "discard")))).join("")).toBe(
      "Partial answer",
    );
  });

  it("separates the texts of successive steps under reply, as the stored reply does", async () => {
    expect(await streamedText("reply")).toBe("Hello, let me check.\n\nIt is open.");
  });
});

describe("stream and stored reply agree", () => {
  interface Step {
    text: string;
    tool?: boolean;
  }

  /** The full stream of a turn made of `steps`, each optionally calling a tool. */
  function turn(steps: Step[]): unknown[] {
    return [
      ...steps.flatMap((step, i) => [
        { type: "start-step" },
        ...(step.text
          ? [
              { type: "text-start", id: `s${i}` },
              { type: "text-delta", id: `s${i}`, text: step.text },
              { type: "text-end", id: `s${i}` },
            ]
          : []),
        ...(step.tool ? [{ type: "tool-call", toolCallId: `t${i}`, toolName: "lookup", input: {} }] : []),
        { type: "finish-step", finishReason: step.tool ? "tool-calls" : "stop" },
      ]),
      { type: "finish" },
    ];
  }

  const turns: Record<string, Step[]> = {
    "a final step after a tool step": [{ text: "Hello.", tool: true }, { text: "Answer." }],
    "a turn that stops on a step that called a tool": [
      { text: "Checking.", tool: true },
      { text: "Still checking.", tool: true },
    ],
    "whitespace and indentation": [
      { text: "Checking.\n\n", tool: true },
      { text: "   ", tool: true },
      { text: '    console.log("hello")\n' },
    ],
  };

  for (const [name, steps] of Object.entries(turns)) {
    for (const policy of ["discard", "reply"] as const) {
      it(`${name}, under ${policy}`, async () => {
        const streamed = (await collect(textDeltas(applyIntermediateTextPolicy(from(turn(steps)), policy)))).join("");
        expect(streamed).toBe(replyTextFor(policy, steps.at(-1)!.text, steps));
      });
    }
  }

  it("delivers the text of a step that called a tool when the turn stops there under discard", async () => {
    const steps = turns["a turn that stops on a step that called a tool"]!;
    expect((await collect(textDeltas(applyIntermediateTextPolicy(from(turn(steps)), "discard")))).join("")).toBe(
      "Still checking.",
    );
  });

  it("keeps each step's whitespace under reply", () => {
    expect(replyTextFor("reply", "", [{ text: "  a\n" }, { text: "" }, { text: "\n    b" }])).toBe("  a\n\n\n\n    b");
  });
});
