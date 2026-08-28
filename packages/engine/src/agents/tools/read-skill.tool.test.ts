// SPDX-License-Identifier: AGPL-3.0-or-later

const { mockResolveInstanceId, mockGetSkillEnvEntries, mockDbSelect } = vi.hoisted(() => ({
  mockResolveInstanceId: vi.fn(),
  mockGetSkillEnvEntries: vi.fn(),
  mockDbSelect: vi.fn(),
}));

vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceId: mockResolveInstanceId,
}));
vi.mock("../../instances/skill-env.store.js", () => ({
  getSkillEnvEntries: mockGetSkillEnvEntries,
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
    mockGetSkillEnvEntries.mockResolvedValue([
      { key: "REGION", value: "eu-west-1", sensitive: false },
    ]);

    const execute = buildReadSkillTool();
    const result = await execute({ name: "booking" }) as any;

    expect(result.found).toBe(true);
    expect(result.name).toBe("booking");
    expect(result.version).toBe("0.1.0");
    expect(result.content).toContain("# Booking Skill");
    expect(result.content).toContain('<var name="REGION">eu-west-1</var>');
  });

  /*
    The property this tool exists to protect: a value the operator marked
    sensitive is encrypted at rest, so it must not arrive in the model's context
    — from which it would reach the conversation history and, through
    `safeOutputPreview`, `tool_audit_logs` in cleartext. The model gets an opaque
    placeholder that `buildTool` resolves between validation and execute.

    Asserted as "the plaintext does not appear", not "the placeholder does",
    because absence of the secret is the guarantee.
  */
  it("should_emit_a_placeholder_and_never_the_value_for_a_sensitive_var", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    const chain = mockSelectChain([{
      enabled: true,
      content: "# CRM Sync",
      version: "1.0.0",
    }]);
    mockDbSelect.mockReturnValue(chain);
    mockGetSkillEnvEntries.mockResolvedValue([
      { key: "CRM_TOKEN", value: "sk-live-a91f", sensitive: true },
      { key: "REGION", value: "eu-west-1", sensitive: false },
    ]);

    const execute = buildReadSkillTool();
    const result = await execute({ name: "crm-sync" }) as any;

    expect(result.content).not.toContain("sk-live-a91f");
    expect(result.content).toContain(
      '<var name="CRM_TOKEN" value="{{skill_env.crm-sync.CRM_TOKEN}}" sensitive />',
    );
    expect(result.content).toContain('<var name="REGION">eu-west-1</var>');
  });

  it("does not inject env block when no env vars exist", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    const chain = mockSelectChain([{
      enabled: true,
      content: "# Simple Skill",
      version: "0.2.0",
    }]);
    mockDbSelect.mockReturnValue(chain);
    mockGetSkillEnvEntries.mockResolvedValue([]);

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
