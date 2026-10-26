// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// SkillsService unit tests — DB-backed implementation
// ---------------------------------------------------------------------------
// DB store functions are mocked. Tests verify the service correctly delegates
// to the stores and maps results to the expected shapes.
// ---------------------------------------------------------------------------

const {
  mockListSkills,
  mockGetSkill,
  mockCreateSkill,
  mockUpdateSkill,
} = vi.hoisted(() => ({
  mockListSkills: vi.fn(),
  mockGetSkill: vi.fn(),
  mockCreateSkill: vi.fn(),
  mockUpdateSkill: vi.fn(),
}));

const { mockDbUpdate } = vi.hoisted(() => ({
  mockDbUpdate: vi.fn(),
}));

vi.mock("./skills.store.js", () => ({
  listSkills: mockListSkills,
  getSkill: mockGetSkill,
  createSkill: mockCreateSkill,
  updateSkill: mockUpdateSkill,
}));

vi.mock("../database/client.js", () => ({
  db: {
    update: mockDbUpdate,
  },
}));

vi.mock("./schema.js", () => ({
  skills: { slug: "slug" },
  skillVersions: {},
  skillTools: {},
}));

vi.mock("drizzle-orm", () => {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
  sqlFn.raw = vi.fn();
  return {
    eq: vi.fn((...args: unknown[]) => args),
    sql: sqlFn,
  };
});

import { SkillsService } from "./skills.service.js";

let service: SkillsService;

beforeEach(() => {
  service = new SkillsService();
  vi.clearAllMocks();
});

// Helper: build a SkillWithVersion row
function buildRow(slug: string, desc: string, content: string, metadata: unknown = {}) {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    description: desc,
    category: "general",
    currentVersionId: `ver-${slug}`,
    status: "active",
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    currentVersion: {
      id: `ver-${slug}`,
      skillId: `id-${slug}`,
      version: "0.1.0",
      content,
      metadata,
      scripts: [],
      changelog: null,
      createdAt: new Date(),
    },
  };
}

// =========================================================================
// listSkills()
// =========================================================================

describe("listSkills", () => {
  it("returns empty array when no skills exist", async () => {
    mockListSkills.mockResolvedValue([]);
    const result = await service.listSkills();
    expect(result).toEqual([]);
  });

  it("maps DB rows to SkillSummary objects", async () => {
    mockListSkills.mockResolvedValue([
      buildRow("web-research", "Research the web", "Use tools."),
      buildRow("code-review", "Review code quality", "Analyze code."),
    ]);

    const result = await service.listSkills();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "web-research",
      displayName: "web-research",
      description: "Research the web",
      category: "general",
    });
    expect(result[1]).toEqual({
      name: "code-review",
      displayName: "code-review",
      description: "Review code quality",
      category: "general",
    });
  });

  it("includes requiredEnv when present in metadata", async () => {
    const requiredEnv = [
      { name: "API_KEY", description: "The API key", sensitive: true },
    ];
    mockListSkills.mockResolvedValue([
      buildRow("api-skill", "Calls APIs", "Body.", { requiredEnv }),
    ]);

    const result = await service.listSkills();

    expect(result).toHaveLength(1);
    expect(result[0].requiredEnv).toEqual(requiredEnv);
  });
});

// =========================================================================
// getSkill()
// =========================================================================

describe("getSkill", () => {
  it("returns SkillDetail with content when found", async () => {
    mockGetSkill.mockResolvedValue(
      buildRow("my-skill", "Does things", "Full content here."),
    );

    const result = await service.getSkill("my-skill");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("my-skill");
    expect(result!.description).toBe("Does things");
    expect(result!.content).toBe("Full content here.");
  });

  it("returns null when skill does not exist", async () => {
    mockGetSkill.mockResolvedValue(null);

    const result = await service.getSkill("nonexistent");

    expect(result).toBeNull();
  });

  it("includes requiredEnv in returned SkillDetail", async () => {
    const requiredEnv = [{ name: "SECRET", sensitive: true }];
    mockGetSkill.mockResolvedValue(
      buildRow("env-skill", "Needs env", "Body.", { requiredEnv }),
    );

    const result = await service.getSkill("env-skill");

    expect(result!.requiredEnv).toEqual(requiredEnv);
  });
});

// =========================================================================
// createSkill()
// =========================================================================

describe("createSkill", () => {
  it("delegates to DB store and returns SkillDetail", async () => {
    const row = buildRow("new-skill", "A brand new skill", "Instructions go here.");
    mockGetSkill.mockResolvedValue(null); // no existing skill
    mockCreateSkill.mockResolvedValue(row);

    const result = await service.createSkill({
      name: "New Skill",
      description: "A brand new skill",
      content: "Instructions go here.",
    });

    expect(mockCreateSkill).toHaveBeenCalledWith({
      slug: "new-skill",
      name: "New Skill",
      description: "A brand new skill",
      content: "Instructions go here.",
      metadata: {},
    });
    expect(result.name).toBe("new-skill");
    expect(result.description).toBe("A brand new skill");
    expect(result.content).toBe("Instructions go here.");
  });

  it("throws when skill already exists (relies on DB unique constraint 23505)", async () => {
    const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });
    mockCreateSkill.mockRejectedValue(uniqueViolation);

    await expect(
      service.createSkill({ name: "existing", description: "d", content: "c" }),
    ).rejects.toThrow('Skill "existing" already exists');
  });

  it("includes requiredEnv in metadata when provided", async () => {
    const requiredEnv = [{ name: "TOKEN", description: "Auth token", sensitive: true }];
    const row = buildRow("env-skill", "Needs env vars", "Body.", { requiredEnv });
    mockGetSkill.mockResolvedValue(null);
    mockCreateSkill.mockResolvedValue(row);

    await service.createSkill({
      name: "env-skill",
      description: "Needs env vars",
      content: "Body.",
      requiredEnv,
    });

    expect(mockCreateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { requiredEnv },
      }),
    );
  });
});

// =========================================================================
// updateSkill()
// =========================================================================

describe("updateSkill", () => {
  it("delegates to DB store and returns SkillDetail", async () => {
    const row = buildRow("my-skill", "Updated description", "Updated content.");
    mockUpdateSkill.mockResolvedValue(row);

    const result = await service.updateSkill("my-skill", {
      description: "Updated description",
      content: "Updated content.",
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("my-skill");
    expect(result!.description).toBe("Updated description");
    expect(result!.content).toBe("Updated content.");
  });

  it("passes a new display name to the store as the name, and addresses the skill by its slug alone", async () => {
    mockUpdateSkill.mockResolvedValue({ ...buildRow("my-skill", "d", "c"), name: "My Skill" });

    const result = await service.updateSkill("my-skill", { displayName: "My Skill", description: "d", content: "c" });

    expect(mockUpdateSkill).toHaveBeenCalledWith("my-skill", expect.objectContaining({ name: "My Skill" }));
    expect(result).toMatchObject({ name: "my-skill", displayName: "My Skill" });
  });

  it("leaves the stored name alone when no display name is given", async () => {
    mockUpdateSkill.mockResolvedValue(buildRow("my-skill", "d", "c"));

    await service.updateSkill("my-skill", { description: "d", content: "c" });

    expect(mockUpdateSkill.mock.calls[0]![1]).toMatchObject({ name: undefined });
  });

  it("returns null when skill does not exist", async () => {
    mockUpdateSkill.mockResolvedValue(null);

    const result = await service.updateSkill("ghost", {
      description: "d",
      content: "c",
    });

    expect(result).toBeNull();
  });
});

// =========================================================================
// deleteSkill()
// =========================================================================

describe("deleteSkill", () => {
  it("soft-deletes an existing skill and returns true", async () => {
    mockGetSkill.mockResolvedValue(buildRow("old-skill", "d", "c"));
    const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockDbUpdate.mockReturnValue({ set: mockSet });

    const result = await service.deleteSkill("old-skill");

    expect(result).toBe(true);
    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it("returns false when skill does not exist", async () => {
    mockGetSkill.mockResolvedValue(null);

    const result = await service.deleteSkill("nonexistent");

    expect(result).toBe(false);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});
