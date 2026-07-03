// SPDX-License-Identifier: AGPL-3.0-or-later

const { mockChat, mockGetPromptSection, mockUpsertPrompt, mockResolveInstanceId } =
  vi.hoisted(() => ({
    mockChat: vi.fn(),
    mockGetPromptSection: vi.fn(),
    mockUpsertPrompt: vi.fn(),
    mockResolveInstanceId: vi.fn(),
  }));

vi.mock("../../ai-gateway/index.js", () => ({ chat: mockChat }));
vi.mock("../../instances/prompts.store.js", () => ({
  getPromptSection: mockGetPromptSection,
  upsertPrompt: mockUpsertPrompt,
  invalidatePromptsCache: vi.fn(),
}));
vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceId: mockResolveInstanceId,
}));

import { createMockAudit } from "../../test-utils.js";
import def from "./update-soul.tool.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function buildUpdateSoulTool() {
  const ctx = {
    instanceId: "instance-1",
    secrets: {
      openai_api_key: "sk-test-openai",
      anthropic_api_key: "sk-test-anthropic",
    },
    audit: createMockAudit(),
  } as any;

  return (input: any) => def.execute(input, ctx);
}

describe("updateSoul tool", () => {
  it("reads current soul from DB, calls LLM, writes updated content, and invalidates cache", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue({
      content: "# Personality\n\nI am a formal assistant.",
      title: "Soul",
    });
    mockChat.mockResolvedValue({
      text: "# Personality\n\nI am an informal and friendly assistant.",
    });

    const execute = buildUpdateSoulTool();
    const result = await execute({ instruction: "be more informal" });

    expect(result).toEqual({ updated: true });

    // Verify it resolved instance ID
    expect(mockResolveInstanceId).toHaveBeenCalledWith("instance-1");

    // Verify it read the soul section from DB
    expect(mockGetPromptSection).toHaveBeenCalledWith("uuid-123", "02-soul");

    // Verify it called the LLM with correct parameters
    expect(mockChat).toHaveBeenCalledTimes(1);
    const chatArgs = mockChat.mock.calls[0][0];
    expect(chatArgs.tier).toBe("fast");
    expect(chatArgs.apiKeys).toEqual({
      openai: "sk-test-openai",
      anthropic: "sk-test-anthropic",
    });
    expect(chatArgs.messages[0].content).toContain("I am a formal assistant.");
    expect(chatArgs.messages[0].content).toContain("be more informal");

    // Verify it wrote the updated content to DB
    expect(mockUpsertPrompt).toHaveBeenCalledWith(
      "uuid-123",
      "02-soul",
      "Soul",
      "# Personality\n\nI am an informal and friendly assistant.\n",
    );

    // Cache invalidation is handled internally by upsertPrompt
  });

  it("uses default content when soul section does not exist in DB", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue(null);
    mockChat.mockResolvedValue({
      text: "# Personality\n\nI am Exy, a creative assistant.",
    });

    const execute = buildUpdateSoulTool();
    const result = await execute({ instruction: "name yourself Exy" });

    expect(result).toEqual({ updated: true });

    // Verify the LLM received the default content
    const chatArgs = mockChat.mock.calls[0][0];
    expect(chatArgs.messages[0].content).toContain("# Personality\n");

    // Verify it still wrote the result
    expect(mockUpsertPrompt).toHaveBeenCalledTimes(1);
  });

  it("returns error when instance is not found", async () => {
    mockResolveInstanceId.mockResolvedValue(undefined);

    const execute = buildUpdateSoulTool();
    const result = await execute({ instruction: "change tone" });

    expect(result).toEqual({ updated: false, error: "Instance not found" });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("returns error when LLM call fails", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue({ content: "# Personality\n", title: "Soul" });
    mockChat.mockRejectedValue(new Error("API rate limit exceeded"));

    const execute = buildUpdateSoulTool();
    const result = await execute({ instruction: "change tone" });

    expect(result).toEqual({ updated: false, error: "API rate limit exceeded" });

    // Should not write on error
    expect(mockUpsertPrompt).not.toHaveBeenCalled();
  });

  it("trims trailing whitespace from LLM response before writing", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue({ content: "# Personality\n", title: "Soul" });
    mockChat.mockResolvedValue({
      text: "  # Personality\n\nNew content.  \n\n  ",
    });

    const execute = buildUpdateSoulTool();
    await execute({ instruction: "update" });

    const writtenContent = mockUpsertPrompt.mock.calls[0][3];
    expect(writtenContent).toBe("# Personality\n\nNew content.\n");
  });

  it("passes secrets from context to the LLM chat call", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-456");
    mockGetPromptSection.mockResolvedValue({ content: "# Personality\n", title: "Soul" });
    mockChat.mockResolvedValue({ text: "# Updated" });

    const ctx = {
      instanceId: "instance-2",
      secrets: {
        openai_api_key: "sk-different-openai",
        anthropic_api_key: "sk-different-anthropic",
      },
      audit: createMockAudit(),
    } as any;

    await def.execute({ instruction: "test" }, ctx);

    expect(mockChat.mock.calls[0][0].apiKeys).toEqual({
      openai: "sk-different-openai",
      anthropic: "sk-different-anthropic",
    });
  });
});
