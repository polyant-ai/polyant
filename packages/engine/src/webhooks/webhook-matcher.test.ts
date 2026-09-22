// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChat, mockWarn } = vi.hoisted(() => ({ mockChat: vi.fn(), mockWarn: vi.fn() }));

vi.mock("../ai-gateway/index.js", () => ({ chat: mockChat }));
vi.mock("./webhook-logger.js", () => ({
  webhookLog: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));
vi.mock("../instances/config-resolver.js", () => ({
  resolveInstanceConfig: vi.fn().mockResolvedValue({ apiKeys: {}, provider: "openai" }),
}));

import { matchEvent } from "./webhook-matcher.js";
import type { EventDefinition } from "./webhook-sources.store.js";

const def = (name: string, id = name): EventDefinition =>
  ({ id, name, matchingPrompt: `match ${name}`, interpretationPrompt: "", action: "backlog", enabled: true }) as EventDefinition;

const PAYLOAD = { action: "labeled", issue: { number: 1 } };
const reply = (text: string) => ({ text, usage: {} });

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT drain the mockResolvedValueOnce queue, so an
  // unconsumed reply from a previous test leaks into the next one and the
  // failure looks like a bug in the code under test. Reset the queue explicitly.
  mockChat.mockReset();
});

describe("matchEvent", () => {
  it("returns the definition on a plain yes", async () => {
    mockChat.mockResolvedValue(reply("yes"));
    expect(await matchEvent(PAYLOAD, [def("a")], "inst")).toMatchObject({ name: "a" });
  });

  it("returns null on a plain no, and does not warn", async () => {
    mockChat.mockResolvedValue(reply("no"));
    expect(await matchEvent(PAYLOAD, [def("a")], "inst")).toBeNull();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("is not fooled by case or surrounding whitespace", async () => {
    for (const text of ["YES", " yes\n", "\tYes  "]) {
      mockChat.mockResolvedValue(reply(text));
      expect(await matchEvent(PAYLOAD, [def("a")], "inst"), text).toMatchObject({ name: "a" });
    }
  });

  it("accepts a yes the model decorated, instead of silently dropping the event", async () => {
    // The regression this test exists for. Strict `answer === "yes"` scored every
    // one of these as NO MATCH, and a non-match is indistinguishable from "no
    // definition was interested": no retry, no backlog row, no trace.
    for (const text of ["Yes.", "yes, the payload carries needs:decision", "Yes!"]) {
      mockChat.mockResolvedValue(reply(text));
      expect(await matchEvent(PAYLOAD, [def("a")], "inst"), text).toMatchObject({ name: "a" });
    }
  });

  it("does not treat a no that merely contains the word yes as a match", async () => {
    for (const text of ["no, this is not a yes", "No — the answer is not yes."]) {
      mockChat.mockResolvedValue(reply(text));
      expect(await matchEvent(PAYLOAD, [def("a")], "inst"), text).toBeNull();
    }
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("WARNS when the answer is neither yes nor no, rather than dropping in silence", async () => {
    mockChat.mockResolvedValue(reply("I cannot determine this from the payload."));
    expect(await matchEvent(PAYLOAD, [def("a")], "inst")).toBeNull();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][1]).toContain("non-yes/no answer");
    expect(mockWarn.mock.calls[0][1]).toContain('"a"');
  });

  it("warns on an empty answer too", async () => {
    mockChat.mockResolvedValue(reply("   "));
    expect(await matchEvent(PAYLOAD, [def("a")], "inst")).toBeNull();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("truncates the quoted answer so a runaway reply cannot flood the log", async () => {
    mockChat.mockResolvedValue(reply("maybe ".repeat(500)));
    await matchEvent(PAYLOAD, [def("a")], "inst");
    expect(mockWarn.mock.calls[0][1].length).toBeLessThan(200);
  });

  it("stops at the first match — definitions are priority-ordered", async () => {
    mockChat.mockResolvedValueOnce(reply("yes")).mockResolvedValueOnce(reply("yes"));
    expect(await matchEvent(PAYLOAD, [def("first"), def("second")], "inst")).toMatchObject({ name: "first" });
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next definition after a no", async () => {
    mockChat.mockResolvedValueOnce(reply("no")).mockResolvedValueOnce(reply("yes"));
    expect(await matchEvent(PAYLOAD, [def("first"), def("second")], "inst")).toMatchObject({ name: "second" });
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it("returns null when there are no definitions at all", async () => {
    expect(await matchEvent(PAYLOAD, [], "inst")).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });
});
