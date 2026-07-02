// SPDX-License-Identifier: AGPL-3.0-or-later

const { mockChat, mockGetPromptSection, mockUpsertPrompt, mockInvalidatePromptsCache, mockResolveInstanceId } =
  vi.hoisted(() => ({
    mockChat: vi.fn(),
    mockGetPromptSection: vi.fn(),
    mockUpsertPrompt: vi.fn(),
    mockInvalidatePromptsCache: vi.fn(),
    mockResolveInstanceId: vi.fn(),
  }));

vi.mock("../../ai-gateway/index.js", () => ({ chat: mockChat }));
vi.mock("../../instances/prompts.store.js", () => ({
  getPromptSection: mockGetPromptSection,
  upsertPrompt: mockUpsertPrompt,
  invalidatePromptsCache: mockInvalidatePromptsCache,
}));
vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceId: mockResolveInstanceId,
}));

import { createMockAudit } from "../../test-utils.js";
import def from "./update-user-profile.tool.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function buildUpdateUserProfileTool() {
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

describe("updateUserProfile tool", () => {
  it("reads current profile from DB, calls LLM, and writes updated content", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue({
      content: "# User\n\n- **Name**: Marco\n- **Age**: 30 years\n",
      title: "User Identity",
    });
    mockChat.mockResolvedValue({
      text: "# User\n\n- **Name**: Marco\n- **Age**: 32 years",
    });

    const execute = buildUpdateUserProfileTool();
    const result = await execute({ instruction: "the user is 32 years old" });

    expect(result).toEqual({ updated: true });

    // Verify it resolved instance ID
    expect(mockResolveInstanceId).toHaveBeenCalledWith("instance-1");

    // Verify it read the profile section from DB
    expect(mockGetPromptSection).toHaveBeenCalledWith("uuid-123", "07-user-identity");

    // Verify it called the LLM with correct parameters
    expect(mockChat).toHaveBeenCalledTimes(1);
    const chatArgs = mockChat.mock.calls[0][0];
    expect(chatArgs.tier).toBe("fast");
    expect(chatArgs.apiKeys).toEqual({
      openai: "sk-test-openai",
      anthropic: "sk-test-anthropic",
    });
    expect(chatArgs.messages[0].content).toContain("Marco");
    expect(chatArgs.messages[0].content).toContain("the user is 32 years old");

    // Verify it wrote the updated content to DB
    expect(mockUpsertPrompt).toHaveBeenCalledWith(
      "uuid-123",
      "07-user-identity",
      "User Identity",
      "# User\n\n- **Name**: Marco\n- **Age**: 32 years\n",
    );
  });

  it("uses default content when profile section does not exist in DB", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue(null);
    mockChat.mockResolvedValue({
      text: "# User\n\n- **Name**: Lucia",
    });

    const execute = buildUpdateUserProfileTool();
    const result = await execute({ instruction: "the user is named Lucia" });

    expect(result).toEqual({ updated: true });

    // Verify the LLM received the default content
    const chatArgs = mockChat.mock.calls[0][0];
    expect(chatArgs.messages[0].content).toContain(
      "No information available about the user.",
    );

    // Verify it still wrote the result
    expect(mockUpsertPrompt).toHaveBeenCalledTimes(1);
  });

  it("returns error when instance is not found", async () => {
    mockResolveInstanceId.mockResolvedValue(undefined);

    const execute = buildUpdateUserProfileTool();
    const result = await execute({ instruction: "update the profile" });

    expect(result).toEqual({ updated: false, error: "Instance not found" });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("returns error when LLM call fails", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue({ content: "# User\n", title: "User Identity" });
    mockChat.mockRejectedValue(new Error("API rate limit exceeded"));

    const execute = buildUpdateUserProfileTool();
    const result = await execute({ instruction: "update the profile" });

    expect(result).toEqual({ updated: false, error: "API rate limit exceeded" });

    // Should not write on error
    expect(mockUpsertPrompt).not.toHaveBeenCalled();
  });

  it("trims trailing whitespace from LLM response before writing", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue({ content: "# User\n", title: "User Identity" });
    mockChat.mockResolvedValue({
      text: "  # User\n\n- **Diet**: vegan  \n\n  ",
    });

    const execute = buildUpdateUserProfileTool();
    await execute({ instruction: "the user follows a vegan diet" });

    const writtenContent = mockUpsertPrompt.mock.calls[0][3];
    expect(writtenContent).toBe("# User\n\n- **Diet**: vegan\n");
  });

  it("passes secrets from context to the LLM chat call", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-456");
    mockGetPromptSection.mockResolvedValue({ content: "# User\n", title: "User Identity" });
    mockChat.mockResolvedValue({ text: "# Updated" });

    const ctx = {
      instanceId: "instance-2",
      secrets: {
        openai_api_key: "sk-custom-openai",
        anthropic_api_key: "sk-custom-anthropic",
      },
      audit: createMockAudit(),
    } as any;

    await def.execute({ instruction: "test" }, ctx);

    expect(mockChat.mock.calls[0][0].apiKeys).toEqual({
      openai: "sk-custom-openai",
      anthropic: "sk-custom-anthropic",
    });
  });

  it("handles non-Error exceptions gracefully", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue({ content: "# User\n", title: "User Identity" });
    mockChat.mockRejectedValue("string error");

    const execute = buildUpdateUserProfileTool();
    const result = await execute({ instruction: "test" });

    expect(result).toEqual({ updated: false, error: "string error" });
  });

  it("includes system prompt instructing markdown list format", async () => {
    mockResolveInstanceId.mockResolvedValue("uuid-123");
    mockGetPromptSection.mockResolvedValue({ content: "# User\n", title: "User Identity" });
    mockChat.mockResolvedValue({ text: "# User" });

    const execute = buildUpdateUserProfileTool();
    await execute({ instruction: "test" });

    const chatArgs = mockChat.mock.calls[0][0];
    expect(chatArgs.system).toContain("**Field**: value");
    expect(chatArgs.system).toContain("# User");
  });
});
