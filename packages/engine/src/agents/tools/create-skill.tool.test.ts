// SPDX-License-Identifier: AGPL-3.0-or-later

const { mockCreateSkill, mockEnableSkill, mockResolveInstanceId } = vi.hoisted(() => ({
  mockCreateSkill: vi.fn(),
  mockEnableSkill: vi.fn(),
  mockResolveInstanceId: vi.fn(),
}));

vi.mock("../../skills/skills.store.js", () => ({ createSkill: mockCreateSkill }));
vi.mock("../../instances/instance-skills.store.js", () => ({ enableSkill: mockEnableSkill }));
vi.mock("../../instances/resolve-instance-id.js", () => ({ resolveInstanceId: mockResolveInstanceId }));

import { createMockAudit } from "../../test-utils.js";
import def from "./create-skill.tool.js";

const run = (input: Record<string, unknown>) =>
  def.execute(input as never, { instanceId: "shop", secrets: {}, audit: createMockAudit() } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockResolveInstanceId.mockResolvedValue("instance-uuid");
});

describe("createSkill tool", () => {
  it("creates the skill and enables it on the calling agent", async () => {
    mockCreateSkill.mockResolvedValue({ id: "skill-1", slug: "weather", name: "weather" });

    const result = await run({
      name: "weather",
      description: "Fetch weather data",
      content: "# Weather",
      requiredEnv: [" OPENWEATHER_API_KEY ", ""],
    });

    expect(result).toEqual({ created: true, name: "weather" });
    expect(mockResolveInstanceId).toHaveBeenCalledWith("shop");
    expect(mockCreateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "weather",
        content: "# Weather",
        metadata: expect.objectContaining({ requiredEnv: ["OPENWEATHER_API_KEY"] }),
      }),
    );
    expect(mockEnableSkill).toHaveBeenCalledWith("instance-uuid", "weather");
  });

  it("turns the name into a slug", async () => {
    mockCreateSkill.mockImplementation(async (input: { slug: string }) => ({ id: "s", slug: input.slug, name: input.slug }));

    await run({ name: "My Skill!", description: "d", content: "c", requiredEnv: null });

    expect(mockCreateSkill.mock.calls[0]![0].slug).toBe("my-skill-");
  });

  it("creates nothing when the calling agent cannot be resolved", async () => {
    mockResolveInstanceId.mockResolvedValue(null);

    const result = await run({ name: "x", description: "d", content: "c", requiredEnv: null });

    expect(result).toMatchObject({ created: false });
    expect(mockCreateSkill).not.toHaveBeenCalled();
  });

  it("reports a created skill as created when enabling it fails", async () => {
    // The row is committed; saying `created: false` would invite a second copy.
    mockCreateSkill.mockResolvedValue({ id: "skill-1", slug: "weather", name: "weather" });
    mockEnableSkill.mockRejectedValue(new Error("enable failed"));

    const result = await run({ name: "weather", description: "d", content: "c", requiredEnv: null });

    expect(result).toEqual({ created: true, name: "weather", error: "enable failed" });
  });

  it("reports a failed creation as not created", async () => {
    mockCreateSkill.mockRejectedValue(new Error("duplicate slug"));

    const result = await run({ name: "weather", description: "d", content: "c", requiredEnv: null });

    expect(result).toEqual({ created: false, error: "duplicate slug" });
    expect(mockEnableSkill).not.toHaveBeenCalled();
  });
});
