// SPDX-License-Identifier: AGPL-3.0-or-later

const { mockResolveInstanceId, mockGetSkillEnv, mockDbSelect } = vi.hoisted(() => ({
  mockResolveInstanceId: vi.fn(),
  mockGetSkillEnv: vi.fn(),
  mockDbSelect: vi.fn(),
}));

vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceId: mockResolveInstanceId,
}));
vi.mock("../../instances/skill-env.store.js", () => ({
  getSkillEnv: mockGetSkillEnv,
}));

// Chain-able mock for drizzle select queries
function mockSelectChain(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

vi.mock("../../database/client.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));
vi.mock("../../instances/instance-skills.schema.js", () => ({
  instanceSkills: { id: "id", instanceId: "instance_id", skillId: "skill_id", skillVersionId: "skill_version_id", enabled: "enabled" },
}));
vi.mock("../../skills/schema.js", () => ({
  skills: { id: "id", slug: "slug", name: "name" },
  skillVersions: { id: "id", content: "content", version: "version" },
}));
vi.mock("../../utils/pipeline-logger.js", () => ({
  pipelineLog: { toolCall: vi.fn(), toolResult: vi.fn() },
}));

import { createMockAudit } from "../../test-utils.js";
import readSkillTool from "./read-skill.tool.js";

const def = readSkillTool;

beforeEach(() => {
  vi.clearAllMocks();
});

function buildReadSkillTool() {
  const ctx = {
    instanceId: "my-instance",
    secrets: {},
    audit: createMockAudit(),
  } as any;
  return (input: Record<string, unknown>) => def.execute(input, ctx);
}

describe("readSkill tool", () => {
  it("returns found: false when instance is not found", async () => {
    mockResolveInstanceId.mockResolvedValue(undefined);

    const execute = buildReadSkillTool();
    const result = await execute({ name: "booking" });

    expect(result).toEqual({ found: false, error: "Instance not found" });
  });

  it("returns found: false when skill is not assigned or disabled", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    const chain = mockSelectChain([]);
    mockDbSelect.mockReturnValue(chain);

    const execute = buildReadSkillTool();
    const result = await execute({ name: "nonexistent" });

    expect(result).toEqual({ found: false });
  });

  it("returns skill content with env vars injected", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    const chain = mockSelectChain([{
      enabled: true,
      content: "# Booking Skill\nBook appointments.",
      version: "0.1.0",
    }]);
    mockDbSelect.mockReturnValue(chain);
    mockGetSkillEnv.mockResolvedValue({ API_KEY: "test-key" });

    const execute = buildReadSkillTool();
    const result = await execute({ name: "booking" }) as any;

    expect(result.found).toBe(true);
    expect(result.name).toBe("booking");
    expect(result.version).toBe("0.1.0");
    expect(result.content).toContain("# Booking Skill");
    expect(result.content).toContain('<var name="API_KEY">test-key</var>');
  });

  it("does not inject env block when no env vars exist", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    const chain = mockSelectChain([{
      enabled: true,
      content: "# Simple Skill",
      version: "0.2.0",
    }]);
    mockDbSelect.mockReturnValue(chain);
    mockGetSkillEnv.mockResolvedValue({});

    const execute = buildReadSkillTool();
    const result = await execute({ name: "simple" }) as any;

    expect(result.found).toBe(true);
    expect(result.content).not.toContain("<skill_env>");
  });

  it("returns error when name is not provided", async () => {
    const execute = buildReadSkillTool();
    const result = await execute({}) as any;

    expect(result).toEqual({ found: false, error: "Missing required parameter 'name'." });
  });

});
