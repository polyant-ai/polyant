// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asAgentSlug } from "../instances/identifiers.js";

const mockChat = vi.fn();
const mockGetRecentMessages = vi.fn();
const mockEmbedMany = vi.fn();
const mockResolveEmbeddingContext = vi.fn();
const mockUpsertMemory = vi.fn();

vi.mock("../ai-gateway/index.js", () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}));

vi.mock("../embeddings-gateway/index.js", () => ({
  embed: (...args: unknown[]) => mockEmbedMany(...args),
  embedMany: (...args: unknown[]) => mockEmbedMany(...args),
  resolveEmbeddingContext: (...args: unknown[]) => mockResolveEmbeddingContext(...args),
}));

vi.mock("./memory-store.js", () => ({
  upsertMemory: (...args: unknown[]) => mockUpsertMemory(...args),
}));

vi.mock("../conversations/index.js", () => ({
  conversationStore: {
    getRecentMessages: (...args: unknown[]) => mockGetRecentMessages(...args),
  },
}));

import { extractMemories } from "./extractor.js";

describe("extractMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockResolveEmbeddingContext.mockResolvedValue({
      instanceId: "user-1",
      dimensions: 1024,
      credentials: { provider: "openai", apiKey: "k" },
    });
  });

  it("loads recent messages, calls LLM, embeds, and upserts results", async () => {
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: "I live in Rome", createdAt: new Date() },
      { role: "assistant", content: "Noted!", createdAt: new Date() },
    ]);

    mockChat.mockResolvedValue({
      text: '[{"content":"The user lives in Rome","category":"fact","importance":8}]',
    });

    mockEmbedMany.mockResolvedValue([[0.1, 0.2, 0.3]]);

    mockUpsertMemory.mockResolvedValue({
      id: "m1",
      content: "The user lives in Rome",
      event: "ADD",
    });

    const results = await extractMemories("conv-1", asAgentSlug("user-1"));

    expect(mockGetRecentMessages).toHaveBeenCalledWith("conv-1", 15);
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "fast",
        messages: [{ role: "user", content: expect.stringContaining("I live in Rome") }],
      }),
      { conversationId: "conv-1", agentId: "user-1", callType: "service" },
    );
    expect(mockEmbedMany).toHaveBeenCalledWith(
      ["The user lives in Rome"],
      expect.objectContaining({ dimensions: 1024 }),
    );
    expect(mockUpsertMemory).toHaveBeenCalledWith({
      agentId: "user-1",
      content: "The user lives in Rome",
      category: "fact",
      importance: 8,
      sourceConversationId: "conv-1",
      embedding: [0.1, 0.2, 0.3],
      dimensions: 1024,
      provider: "openai",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: "m1",
      content: "The user lives in Rome",
      event: "ADD",
    });
  });

  it("passes langsmith config to chat when provided", async () => {
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: "Test message", createdAt: new Date() },
    ]);
    mockChat.mockResolvedValue({ text: "[]" });

    await extractMemories("conv-1", asAgentSlug("user-1"), undefined, undefined, { apiKey: "ls-key", project: "proj" });

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        langsmith: { apiKey: "ls-key", project: "proj" },
      }),
      expect.objectContaining({ callType: "service" }),
    );
  });

  it("returns early when no messages found", async () => {
    mockGetRecentMessages.mockResolvedValue([]);

    const results = await extractMemories("conv-1", asAgentSlug("user-1"));

    expect(results).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockEmbedMany).not.toHaveBeenCalled();
    expect(mockUpsertMemory).not.toHaveBeenCalled();
  });

  it("filters out messages with empty content", async () => {
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: "Hello", createdAt: new Date() },
      { role: "assistant", content: "", createdAt: new Date() },
    ]);

    mockChat.mockResolvedValue({
      text: '[{"content":"The user said hello","category":"general","importance":2}]',
    });

    mockEmbedMany.mockResolvedValue([[0.1, 0.2]]);
    mockUpsertMemory.mockResolvedValue({
      id: "m1",
      content: "The user said hello",
      event: "ADD",
    });

    await extractMemories("conv-1", asAgentSlug("user-1"));

    // The transcript sent to the LLM should only contain the non-empty message
    const chatCall = mockChat.mock.calls[0];
    const transcript = chatCall[0].messages[0].content as string;
    expect(transcript).toContain("User: Hello");
    expect(transcript).not.toContain("Assistant: ");
  });

  it("returns early when all messages have empty content", async () => {
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: "", createdAt: new Date() },
      { role: "assistant", content: "", createdAt: new Date() },
    ]);

    const results = await extractMemories("conv-1", asAgentSlug("user-1"));

    expect(results).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("handles non-string content gracefully", async () => {
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: { type: "tool_result" }, createdAt: new Date() },
      { role: "assistant", content: "Reply", createdAt: new Date() },
    ]);

    mockChat.mockResolvedValue({
      text: '[{"content":"The user received a reply","category":"general","importance":3}]',
    });

    mockEmbedMany.mockResolvedValue([[0.4, 0.5]]);
    mockUpsertMemory.mockResolvedValue({
      id: "m1",
      content: "The user received a reply",
      event: "ADD",
    });

    await extractMemories("conv-1", asAgentSlug("user-1"));

    // Non-string content becomes "" and gets filtered out of the transcript
    const chatCall = mockChat.mock.calls[0];
    const transcript = chatCall[0].messages[0].content as string;
    expect(transcript).toContain("Assistant: Reply");
    expect(transcript).not.toContain("User:");
  });

  it("returns empty when LLM extracts nothing (no summary log)", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: "Hi", createdAt: new Date() },
    ]);

    mockChat.mockResolvedValue({
      text: "[]",
    });

    const results = await extractMemories("conv-1", asAgentSlug("user-1"));

    expect(results).toEqual([]);
    expect(mockEmbedMany).not.toHaveBeenCalled();
    expect(mockUpsertMemory).not.toHaveBeenCalled();

    // No summary log when there are zero facts
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).not.toContain("[MemoryExtractor]");
  });

  it("logs a summary line after extraction", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: "I like pizza", createdAt: new Date() },
    ]);

    mockChat.mockResolvedValue({
      text: '[{"content":"The user likes pizza","category":"preference","importance":6}]',
    });

    mockEmbedMany.mockResolvedValue([[0.1, 0.2]]);
    mockUpsertMemory.mockResolvedValue({
      id: "m1",
      content: "The user likes pizza",
      event: "ADD",
    });

    await extractMemories("conv-1", asAgentSlug("user-1"));

    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("1 fact(s)");
    expect(output).toContain("added=1");
    expect(output).toContain("updated=0");
  });

  it("handles invalid JSON from LLM gracefully (returns empty array)", async () => {
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: "Something", createdAt: new Date() },
    ]);

    mockChat.mockResolvedValue({
      text: "This is not valid JSON at all",
    });

    const results = await extractMemories("conv-1", asAgentSlug("user-1"));

    expect(results).toEqual([]);
    expect(mockEmbedMany).not.toHaveBeenCalled();
    expect(mockUpsertMemory).not.toHaveBeenCalled();
  });

  it("batch-embeds all extracted facts in one call", async () => {
    mockGetRecentMessages.mockResolvedValue([
      { role: "user", content: "I live in Rome and I like pasta", createdAt: new Date() },
    ]);

    mockChat.mockResolvedValue({
      text: JSON.stringify([
        { content: "The user lives in Rome", category: "fact", importance: 8 },
        { content: "The user likes pasta", category: "preference", importance: 6 },
      ]),
    });

    mockEmbedMany.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    mockUpsertMemory
      .mockResolvedValueOnce({ id: "m1", content: "The user lives in Rome", event: "ADD" })
      .mockResolvedValueOnce({ id: "m2", content: "The user likes pasta", event: "ADD" });

    const results = await extractMemories("conv-1", asAgentSlug("user-1"));

    // All facts embedded in a single batch call
    expect(mockEmbedMany).toHaveBeenCalledTimes(1);
    expect(mockEmbedMany).toHaveBeenCalledWith(
      ["The user lives in Rome", "The user likes pasta"],
      expect.objectContaining({ dimensions: 1024 }),
    );

    // Each fact upserted with its corresponding embedding
    expect(mockUpsertMemory).toHaveBeenCalledTimes(2);
    expect(mockUpsertMemory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: "The user lives in Rome",
      embedding: [0.1, 0.2],
    }));
    expect(mockUpsertMemory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      content: "The user likes pasta",
      embedding: [0.3, 0.4],
    }));

    expect(results).toHaveLength(2);
  });
});
