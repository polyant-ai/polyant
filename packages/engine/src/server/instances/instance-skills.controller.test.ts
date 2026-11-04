// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bodies the agent's skill routes accept. A malformed body must answer 400
 * before anything is written: a missing list used to read as "disable every
 * skill", and a missing or string `sensitive` used to store a secret in clear.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  getInstanceSkills: vi.fn(),
  enableSkill: vi.fn(),
  disableSkill: vi.fn(),
  setAutoLoad: vi.fn(),
  rollbackSkill: vi.fn(),
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  getEnabledToolNames: vi.fn(),
  setSkillEnv: vi.fn(),
  getSkillEnv: vi.fn(),
  hasAllRequiredEnvBatch: vi.fn(),
  getPinnedSkillMetadata: vi.fn(),
}));
vi.mock("../../instances/instance-skills.store.js", () => ({
  getInstanceSkills: stores.getInstanceSkills,
  enableSkill: stores.enableSkill,
  disableSkill: stores.disableSkill,
  upgradeSkill: vi.fn(),
  rollbackSkill: stores.rollbackSkill,
  setAutoLoad: stores.setAutoLoad,
  getPinnedSkillMetadata: stores.getPinnedSkillMetadata,
}));
vi.mock("../../skills/skills.store.js", () => ({ listSkills: stores.listSkills, getSkill: stores.getSkill }));
vi.mock("../../instances/instance-tools.store.js", () => ({ getEnabledToolNames: stores.getEnabledToolNames }));
vi.mock("../../instances/skill-env.store.js", () => ({
  setSkillEnv: stores.setSkillEnv,
  getSkillEnv: stores.getSkillEnv,
  deleteSkillEnv: vi.fn(),
  hasAllRequiredEnvBatch: stores.hasAllRequiredEnvBatch,
}));
vi.mock("./instance-helpers.js", () => ({
  findInstanceOrFail: vi.fn(async (slug: string) => ({ id: "agent-uuid", slug })),
}));

import { NotFoundException } from "@nestjs/common";
import { InstanceSkillsController } from "./instance-skills.controller.js";

const weatherSkill = {
  slug: "weather",
  status: "active",
  description: "Weather",
  category: "general",
  currentVersion: {
    version: 1,
    metadata: {
      requiredEnv: [
        { name: "API_KEY", sensitive: true },
        { name: "UNITS", sensitive: false },
      ],
    },
  },
};

describe("InstanceSkillsController bodies", () => {
  const controller = new InstanceSkillsController();

  beforeEach(() => {
    vi.clearAllMocks();
    stores.getInstanceSkills.mockResolvedValue([{ skillSlug: "weather", enabled: true }]);
    stores.listSkills.mockResolvedValue([weatherSkill]);
    stores.getSkill.mockResolvedValue(weatherSkill);
    stores.getEnabledToolNames.mockResolvedValue(new Set());
    stores.getSkillEnv.mockResolvedValue({});
    stores.hasAllRequiredEnvBatch.mockResolvedValue(new Map());
    stores.getPinnedSkillMetadata.mockResolvedValue(weatherSkill.currentVersion.metadata);
  });

  describe("PATCH skills", () => {
    it.each([
      ["an empty body", {}],
      ["enabled as a string", { enabled: "weather" }],
    ])("refuses %s instead of disabling every skill", async (_label, body) => {
      await expect(controller.updateSkills("acme", body as never)).rejects.toThrow(/enabled/);
      expect(stores.disableSkill).not.toHaveBeenCalled();
      expect(stores.enableSkill).not.toHaveBeenCalled();
    });

    it("disables a skill left out of the list", async () => {
      await controller.updateSkills("acme", { enabled: [] });
      expect(stores.disableSkill).toHaveBeenCalledWith("agent-uuid", "weather");
    });
  });

  describe("PUT skill env", () => {
    it.each([
      ["sensitive missing", { key: "UNITS", value: "metric" }],
      ["sensitive as a string", { key: "UNITS", value: "metric", sensitive: "false" }],
      ["value missing", { key: "UNITS", sensitive: false }],
    ])("refuses an entry with %s", async (_label, entry) => {
      await expect(controller.setSkillEnvVars("acme", "weather", { env: [entry] } as never)).rejects.toThrow(/env/);
      expect(stores.setSkillEnv).not.toHaveBeenCalled();
    });

    it("refuses a key the skill does not declare, writing nothing", async () => {
      await expect(
        controller.setSkillEnvVars("acme", "weather", {
          env: [
            { key: "UNITS", value: "metric", sensitive: false },
            { key: "NOT_DECLARED", value: "x", sensitive: false },
          ],
        }),
      ).rejects.toThrow(/NOT_DECLARED/);
      expect(stores.setSkillEnv).not.toHaveBeenCalled();
    });

    it("stores a key the skill declares sensitive encrypted, whatever the client says", async () => {
      await controller.setSkillEnvVars("acme", "weather", {
        env: [{ key: "API_KEY", value: "sk-live", sensitive: false }],
      });
      expect(stores.setSkillEnv).toHaveBeenCalledWith(expect.objectContaining({ key: "API_KEY", sensitive: true }));
    });

    it("reports a key whose metadata omits the flag as a plain setting, so the panel can send it back", async () => {
      stores.getSkill.mockResolvedValue({
        ...weatherSkill,
        currentVersion: { version: 1, metadata: { requiredEnv: [{ name: "REGION" }] } },
      });
      stores.getPinnedSkillMetadata.mockResolvedValue({ requiredEnv: [{ name: "REGION" }] });
      stores.getSkillEnv.mockResolvedValue({ REGION: "eu" });
      const { env } = await controller.getSkillEnvVars("acme", "weather");
      expect(env).toEqual([{ key: "REGION", value: "eu", sensitive: false, configured: true, description: undefined }]);
    });

    it("sets and rotates a key the version the agent runs reads, after a newer version renamed it", async () => {
      // The agent stays on the version that reads API_TOKEN; the skill's current one reads CRM_TOKEN.
      stores.getSkill.mockResolvedValue({
        ...weatherSkill,
        currentVersion: { version: 2, metadata: { requiredEnv: [{ name: "CRM_TOKEN", sensitive: true }] } },
      });
      stores.getPinnedSkillMetadata.mockResolvedValue({ requiredEnv: [{ name: "API_TOKEN", sensitive: true }] });
      stores.getSkillEnv.mockResolvedValue({ API_TOKEN: "rotated" });

      const { env } = await controller.setSkillEnvVars("acme", "weather", {
        env: [{ key: "API_TOKEN", value: "rotated", sensitive: false }],
      });

      expect(stores.setSkillEnv).toHaveBeenCalledWith(expect.objectContaining({ key: "API_TOKEN", sensitive: true }));
      expect(env.map((e: { key: string }) => e.key)).toEqual(["API_TOKEN", "CRM_TOKEN"]);
    });

    it("answers 404 for an unknown skill before writing anything", async () => {
      stores.getSkill.mockResolvedValue(null);
      await expect(
        controller.setSkillEnvVars("acme", "nope", { env: [{ key: "A", value: "b", sensitive: false }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(stores.setSkillEnv).not.toHaveBeenCalled();
    });
  });

  it("refuses an auto-load switch that is not a boolean", async () => {
    await expect(controller.toggleAutoLoad("acme", "weather", { autoLoad: "false" } as never)).rejects.toThrow(/autoLoad/);
    expect(stores.setAutoLoad).not.toHaveBeenCalled();
  });
});
