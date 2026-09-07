// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../../../instances/identifiers.js";

const { mockEntries } = vi.hoisted(() => ({ mockEntries: vi.fn() }));
vi.mock("../../../instances/skill-env.store.js", () => ({
  getSkillEnvEntries: (...a: unknown[]) => mockEntries(...a),
}));

import { hasPlaceholder, substituteSkillEnv } from "./skill-env-placeholder.js";

const INSTANCE = asInstanceSlug("acme");

beforeEach(() => {
  vi.clearAllMocks();
  mockEntries.mockResolvedValue([]);
});

describe("hasPlaceholder", () => {
  it("should_find_a_placeholder_nested_in_an_object", () => {
    expect(hasPlaceholder({ a: { b: ["x", "{{skill_env.crm-sync.TOKEN}}"] } })).toBe(true);
  });

  it("should_return_false_for_a_tree_with_none", () => {
    expect(hasPlaceholder({ a: { b: ["x", 3, null] } })).toBe(false);
  });

  /*
    PLACEHOLDER_RE is global, so it carries `lastIndex` between calls. If the
    sweep forgets to reset it, the SECOND tool call of a turn silently skips
    substitution — the failure mode this test exists to pin.
  */
  it("should_give_the_same_answer_when_asked_twice", () => {
    const v = "{{skill_env.crm-sync.TOKEN}}";
    expect(hasPlaceholder(v)).toBe(true);
    expect(hasPlaceholder(v)).toBe(true);
  });
});

describe("substituteSkillEnv", () => {
  it("should_replace_a_sensitive_placeholder_anywhere_in_the_tree", async () => {
    mockEntries.mockResolvedValue([{ key: "CRM_TOKEN", value: "sk-live-a91f", sensitive: true }]);

    const out = await substituteSkillEnv(
      { headers: { Authorization: "Bearer {{skill_env.crm-sync.CRM_TOKEN}}" }, n: 3 },
      INSTANCE,
    );

    expect(out).toEqual({ headers: { Authorization: "Bearer sk-live-a91f" }, n: 3 });
  });

  /*
    Leaving an unknown placeholder alone is deliberate. Replacing it with an
    empty string sends `Authorization: Bearer ` and produces a confusing 401
    instead of a legible failure the model can report.
  */
  it("should_leave_an_unknown_placeholder_untouched", async () => {
    mockEntries.mockResolvedValue([]);
    expect(await substituteSkillEnv("{{skill_env.crm-sync.NOPE}}", INSTANCE)).toBe(
      "{{skill_env.crm-sync.NOPE}}",
    );
  });

  /*
    A non-sensitive var is emitted inline by readSkill, so a placeholder naming
    one is a model invention rather than our contract. Substituting it would
    turn the substituter into an oracle for which keys exist.
  */
  it("should_not_substitute_a_non_sensitive_key", async () => {
    mockEntries.mockResolvedValue([{ key: "REGION", value: "eu-west-1", sensitive: false }]);
    expect(await substituteSkillEnv("{{skill_env.crm-sync.REGION}}", INSTANCE)).toBe(
      "{{skill_env.crm-sync.REGION}}",
    );
  });

  it("should_resolve_each_skill_once_however_many_placeholders_it_has", async () => {
    mockEntries.mockResolvedValue([
      { key: "A", value: "1", sensitive: true },
      { key: "B", value: "2", sensitive: true },
    ]);

    const out = await substituteSkillEnv(
      ["{{skill_env.crm-sync.A}}", "{{skill_env.crm-sync.B}}", "{{skill_env.crm-sync.A}}"],
      INSTANCE,
    );

    expect(out).toEqual(["1", "2", "1"]);
    expect(mockEntries).toHaveBeenCalledTimes(1);
  });

  it("should_pass_a_tree_with_no_placeholder_through_unchanged", async () => {
    const input = { a: 1, b: ["x", null], c: { d: true } };
    expect(await substituteSkillEnv(input, INSTANCE)).toEqual(input);
    expect(mockEntries).not.toHaveBeenCalled();
  });
});
