// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import type { SkillsService } from "./skills.service.js";

vi.mock("./skills.store.js", () => ({ getSkill: vi.fn(), listVersions: vi.fn(), getSkillVersion: vi.fn() }));
vi.mock("./skills-export.service.js", () => ({ exportSkillsCatalog: vi.fn(), exportSingleSkill: vi.fn(), importSkillsCatalog: vi.fn() }));

import { SkillsController } from "./skills.controller.js";

function setup() {
  const updateSkill = vi.fn(async (_slug: string, data: { displayName?: string; description: string }) => ({
    name: "my-skill",
    displayName: data.displayName ?? "kept",
    description: data.description,
    content: "c",
  }));
  const controller = new SkillsController({ updateSkill } as unknown as SkillsService);
  return { controller, updateSkill };
}

const base = { content: "c" };

describe("PUT /api/skills/:name — name and description", () => {
  it("passes a trimmed display name and the description on, addressing the skill by the URL slug", async () => {
    const { controller, updateSkill } = setup();
    await controller.update("my-skill", { ...base, displayName: "  Research the web  ", description: "Finds things" });
    expect(updateSkill).toHaveBeenCalledWith("my-skill", expect.objectContaining({ displayName: "Research the web", description: "Finds things" }));
  });

  it("ignores a slug or name in the body: the slug is not an input", async () => {
    const { controller, updateSkill } = setup();
    await controller.update("my-skill", { ...base, description: "d", slug: "other", name: "other" } as never);
    const [slug, data] = updateSkill.mock.calls[0]!;
    expect(slug).toBe("my-skill");
    expect(data).not.toHaveProperty("displayName");
  });

  it("keeps the name when none is sent, and accepts an empty description", async () => {
    const { controller, updateSkill } = setup();
    await controller.update("my-skill", { ...base, description: "" });
    expect(updateSkill).toHaveBeenCalledOnce();
  });

  it.each([
    ["a blank name", { displayName: "   ", description: "d" }],
    ["a name that is not text", { displayName: 5, description: "d" }],
    ["a name over 255 characters", { displayName: "x".repeat(256), description: "d" }],
    ["a description that is not text", { description: 5 }],
    ["a missing description", {}],
    ["a description over 2000 characters", { description: "x".repeat(2001) }],
  ])("refuses %s with 400 and writes nothing", async (_label, body) => {
    const { controller, updateSkill } = setup();
    await expect(controller.update("my-skill", { ...base, ...body } as never)).rejects.toMatchObject({ status: 400 });
    expect(updateSkill).not.toHaveBeenCalled();
  });
});
