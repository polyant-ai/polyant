// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { evaluateOptout } from "./optout.guard.js";
import type { OptoutConfig } from "./optout.types.js";

const cfg: OptoutConfig = {
  enabled: true,
  stopKeywords: ["STOP"],
  resumeKeywords: ["START"],
  closingMessage: "You have been unsubscribed.",
  resumeMessage: "Welcome back.",
  injectPromptHint: true,
};

describe("evaluateOptout", () => {
  it("passes through when the feature is disabled", () => {
    const r = evaluateOptout({ config: { ...cfg, enabled: false }, currentStatus: "opted_in", messageText: "STOP" });
    expect(r).toEqual({ kind: "pass" });
  });

  it("opts out on an exact stop keyword (case/space-insensitive)", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_in", messageText: "  stop " });
    expect(r).toEqual({ kind: "stop", reply: "You have been unsubscribed." });
  });

  it("does NOT opt out when the keyword is a substring of a longer message", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_in", messageText: "please don't stop now" });
    expect(r).toEqual({ kind: "pass" });
  });

  it("resumes on an exact resume keyword when opted out", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_out", messageText: "start" });
    expect(r).toEqual({ kind: "resume", reply: "Welcome back." });
  });

  it("stays silent for any other message while opted out", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_out", messageText: "hello?" });
    expect(r).toEqual({ kind: "blocked_silent" });
  });

  it("is idempotent: a repeated stop keyword while opted out is silent (no second confirmation)", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_out", messageText: "STOP" });
    expect(r).toEqual({ kind: "blocked_silent" });
  });

  it("treats a resume keyword while already subscribed as a normal message", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_in", messageText: "START" });
    expect(r).toEqual({ kind: "pass" });
  });

  it("supports multiple stop keywords", () => {
    const r = evaluateOptout({ config: { ...cfg, stopKeywords: ["STOP", "UNSUBSCRIBE"] }, currentStatus: "opted_in", messageText: "unsubscribe" });
    expect(r).toEqual({ kind: "stop", reply: "You have been unsubscribed." });
  });

  it("returns null reply when no closing message is configured", () => {
    const r = evaluateOptout({ config: { ...cfg, closingMessage: null }, currentStatus: "opted_in", messageText: "STOP" });
    expect(r).toEqual({ kind: "stop", reply: null });
  });
});
