// SPDX-License-Identifier: AGPL-3.0-or-later

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockRmSync = vi.hoisted(() => vi.fn());

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  rmSync: mockRmSync,
}));

import {
  getWorkspacePaths,
  getConversationWorkspacePath,
  deleteWorkspace,
  deleteConversationWorkspace,
} from "./index.js";
import { OA_SANDBOX_ROOT } from "../agents/tools/shared/workspace-utils.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWorkspacePaths", () => {
  it("returns root and conversationsDir", () => {
    const paths = getWorkspacePaths("my-instance");
    expect(paths.root).toBe(`${OA_SANDBOX_ROOT}/my-instance`);
    expect(paths.conversationsDir).toBe(`${OA_SANDBOX_ROOT}/my-instance/conversations`);
  });

  it("rejects invalid instanceId with uppercase", () => {
    expect(() => getWorkspacePaths("MY-INSTANCE")).toThrow(/Invalid instanceId/);
  });

  it("rejects instanceId starting with hyphen", () => {
    expect(() => getWorkspacePaths("-my-instance")).toThrow(/Invalid instanceId/);
  });

  it("rejects instanceId with spaces or special chars", () => {
    expect(() => getWorkspacePaths("my instance!")).toThrow(/Invalid instanceId/);
  });

  it("accepts alphanumeric + hyphen + digits", () => {
    expect(() => getWorkspacePaths("abc-123")).not.toThrow();
    expect(() => getWorkspacePaths("a")).not.toThrow();
    expect(() => getWorkspacePaths("1abc")).not.toThrow();
  });
});

describe("getConversationWorkspacePath", () => {
  it("returns path under conversationsDir using a safe conversationId", () => {
    const path = getConversationWorkspacePath("my-instance", "conv-1");
    expect(path).toBe(`${OA_SANDBOX_ROOT}/my-instance/conversations/conv-1`);
  });

  it("sanitizes conversationId with colons (typical real-world format)", () => {
    const path = getConversationWorkspacePath("my-instance", "inst:web:chat-123");
    expect(path).toBe(`${OA_SANDBOX_ROOT}/my-instance/conversations/inst_web_chat-123`);
  });

  it("sanitizes conversationId with slashes (path injection attempt)", () => {
    const path = getConversationWorkspacePath("my-instance", "foo/../bar");
    // slashes and dots from traversal are replaced by _ — resulting dir is safe
    expect(path).toBe(`${OA_SANDBOX_ROOT}/my-instance/conversations/foo_.._bar`);
  });

  it("validates the instanceId", () => {
    expect(() => getConversationWorkspacePath("BAD!", "conv-1")).toThrow(/Invalid instanceId/);
  });

  it("rejects empty conversationId", () => {
    expect(() => getConversationWorkspacePath("my-instance", "")).toThrow(/conversationId is required/);
  });
});

describe("deleteWorkspace", () => {
  it("removes the root directory when it exists", () => {
    mockExistsSync.mockReturnValue(true);
    deleteWorkspace("my-instance");
    expect(mockRmSync).toHaveBeenCalledWith(
      `${OA_SANDBOX_ROOT}/my-instance`,
      { recursive: true, force: true },
    );
  });

  it("is a no-op when the directory does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    deleteWorkspace("my-instance");
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("validates the instanceId", () => {
    expect(() => deleteWorkspace("BAD!")).toThrow(/Invalid instanceId/);
    expect(mockRmSync).not.toHaveBeenCalled();
  });
});

describe("deleteConversationWorkspace", () => {
  it("removes the conversation directory when it exists", () => {
    mockExistsSync.mockReturnValue(true);
    deleteConversationWorkspace("my-instance", "conv-1");
    expect(mockRmSync).toHaveBeenCalledWith(
      `${OA_SANDBOX_ROOT}/my-instance/conversations/conv-1`,
      { recursive: true, force: true },
    );
  });

  it("is a no-op when the directory does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    deleteConversationWorkspace("my-instance", "conv-1");
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("sanitizes the conversationId before deletion", () => {
    mockExistsSync.mockReturnValue(true);
    deleteConversationWorkspace("my-instance", "inst:web:chat-1");
    expect(mockRmSync).toHaveBeenCalledWith(
      `${OA_SANDBOX_ROOT}/my-instance/conversations/inst_web_chat-1`,
      { recursive: true, force: true },
    );
  });

  it("validates the instanceId", () => {
    expect(() => deleteConversationWorkspace("BAD!", "conv-1")).toThrow(/Invalid instanceId/);
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("does NOT touch other conversation directories", () => {
    mockExistsSync.mockReturnValue(true);
    deleteConversationWorkspace("my-instance", "conv-1");
    // Should only be called once, with exactly this conversation's dir
    expect(mockRmSync).toHaveBeenCalledTimes(1);
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("/conversations/conv-1"),
      expect.any(Object),
    );
  });
});
