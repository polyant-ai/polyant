// SPDX-License-Identifier: AGPL-3.0-or-later

const mockMkdir = vi.hoisted(() => vi.fn());
// realpath is mocked as identity for the non-symlink test suites below — the
// realpath-based symlink defense is tested against real fs in
// workspace-utils.symlink.test.ts using fs.symlinkSync in a tmpdir.
const mockRealpath = vi.hoisted(() => vi.fn(async (p: string) => p));

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  realpath: mockRealpath,
}));

import {
  OA_SANDBOX_ROOT,
  getConversationWorkspaceDir,
  isRelativePath,
  assertInsideWorkspace,
  assertInsideConversationWorkspace,
  resolveWorkspacePath,
  sanitizeConversationId,
  ensureWorkspaceDir,
} from "./workspace-utils.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockRealpath.mockImplementation(async (p: string) => p);
});

describe("sanitizeConversationId", () => {
  it("keeps safe characters unchanged", () => {
    expect(sanitizeConversationId("abc-123.test_ok")).toBe("abc-123.test_ok");
  });

  it("replaces colons (common in real conversationIds)", () => {
    expect(sanitizeConversationId("inst:web:user-xyz")).toBe("inst_web_user-xyz");
  });

  it("replaces slashes to prevent path injection", () => {
    expect(sanitizeConversationId("foo/../bar")).toBe("foo_.._bar");
  });

  it("replaces spaces, @, + and other unsafe chars", () => {
    expect(sanitizeConversationId("user+name@example.com")).toBe("user_name_example.com");
  });

  it("throws on empty string", () => {
    expect(() => sanitizeConversationId("")).toThrow(/conversationId is required/);
  });
});

describe("getConversationWorkspaceDir", () => {
  it("returns absolute path under OA_SANDBOX_ROOT", () => {
    const dir = getConversationWorkspaceDir("my-instance", "conv-1");
    expect(dir).toBe(`${OA_SANDBOX_ROOT}/my-instance/conversations/conv-1`);
  });

  it("sanitizes the conversationId", () => {
    const dir = getConversationWorkspaceDir("my-instance", "inst:web:chat-123");
    expect(dir).toBe(`${OA_SANDBOX_ROOT}/my-instance/conversations/inst_web_chat-123`);
  });

  it("rejects invalid agentId", () => {
    expect(() => getConversationWorkspaceDir("Bad Agent!", "conv-1")).toThrow(/Invalid agentId/);
  });

  it("rejects uppercase agentId", () => {
    expect(() => getConversationWorkspaceDir("MY-INSTANCE", "conv-1")).toThrow(/Invalid agentId/);
  });
});

describe("isRelativePath", () => {
  it("returns true for relative paths", () => {
    expect(isRelativePath("foo.txt")).toBe(true);
    expect(isRelativePath("sub/dir/file.md")).toBe(true);
    expect(isRelativePath("./foo")).toBe(true);
    expect(isRelativePath("../foo")).toBe(true);
  });

  it("returns false for absolute POSIX paths", () => {
    expect(isRelativePath("/etc/passwd")).toBe(false);
    expect(isRelativePath("/tmp/foo.txt")).toBe(false);
  });
});

describe("assertInsideWorkspace", () => {
  const workspaceDir = "/workspaces/inst/conversations/conv-1";

  it("allows paths exactly matching the workspace root", () => {
    expect(() => assertInsideWorkspace(workspaceDir, workspaceDir)).not.toThrow();
  });

  it("allows paths strictly inside the workspace", () => {
    expect(() => assertInsideWorkspace(`${workspaceDir}/file.txt`, workspaceDir)).not.toThrow();
    expect(() => assertInsideWorkspace(`${workspaceDir}/sub/dir/file.txt`, workspaceDir)).not.toThrow();
  });

  it("rejects paths outside the workspace", () => {
    expect(() => assertInsideWorkspace("/etc/passwd", workspaceDir)).toThrow(/Access denied/);
    expect(() => assertInsideWorkspace("/workspaces/inst/conversations/conv-2/x", workspaceDir)).toThrow(/Access denied/);
  });

  it("rejects paths that are a prefix but not inside (e.g. sibling with shared prefix)", () => {
    expect(() => assertInsideWorkspace(`${workspaceDir}-other/file`, workspaceDir)).toThrow(/Access denied/);
  });
});

describe("resolveWorkspacePath", () => {
  const agentId = "my-instance";
  const conversationId = "conv-1";
  const workspaceDir = `${OA_SANDBOX_ROOT}/${agentId}/conversations/${conversationId}`;

  it("resolves a simple relative path inside the workspace", async () => {
    const resolved = await resolveWorkspacePath("notes.md", agentId, conversationId);
    expect(resolved).toBe(`${workspaceDir}/notes.md`);
  });

  it("resolves nested relative paths", async () => {
    const resolved = await resolveWorkspacePath("output/report.md", agentId, conversationId);
    expect(resolved).toBe(`${workspaceDir}/output/report.md`);
  });

  it("normalizes '.' segments", async () => {
    const resolved = await resolveWorkspacePath("./foo/./bar.txt", agentId, conversationId);
    expect(resolved).toBe(`${workspaceDir}/foo/bar.txt`);
  });

  it("blocks traversal via '../'", async () => {
    await expect(resolveWorkspacePath("../../etc/passwd", agentId, conversationId))
      .rejects.toThrow(/Access denied/);
  });

  it("blocks traversal that uses .. segments to escape", async () => {
    await expect(resolveWorkspacePath("foo/../../../../../etc/passwd", agentId, conversationId))
      .rejects.toThrow(/Access denied/);
  });

  it("allows traversal that resolves inside the workspace", async () => {
    const resolved = await resolveWorkspacePath("foo/../bar.txt", agentId, conversationId);
    expect(resolved).toBe(`${workspaceDir}/bar.txt`);
  });

  it("rejects null bytes", async () => {
    await expect(resolveWorkspacePath("foo\0bar.txt", agentId, conversationId))
      .rejects.toThrow(/null byte/);
  });

  it("rejects absolute paths", async () => {
    await expect(resolveWorkspacePath("/etc/passwd", agentId, conversationId))
      .rejects.toThrow(/only accepts relative paths/);
  });

  it("rejects empty string", async () => {
    await expect(resolveWorkspacePath("", agentId, conversationId))
      .rejects.toThrow(/is required/);
  });

  it("sanitizes conversationId with unsafe characters", async () => {
    const resolved = await resolveWorkspacePath("note.md", agentId, "inst:web:chat-1");
    expect(resolved).toBe(`${OA_SANDBOX_ROOT}/${agentId}/conversations/inst_web_chat-1/note.md`);
  });

  it("blocks paths when realpath resolves outside the workspace (symlink escape)", async () => {
    // Simulate: target path exists and its realpath points OUTSIDE the workspace
    mockRealpath.mockImplementation(async (p: string) => {
      if (p === `${workspaceDir}/evil`) return "/etc/passwd";
      return p; // workspace and ancestors resolve to themselves
    });

    await expect(resolveWorkspacePath("evil", agentId, conversationId))
      .rejects.toThrow(/Access denied/);
  });

  it("accepts symlinks that resolve inside the workspace", async () => {
    // Simulate: target is a symlink that points to another file STILL inside the workspace
    mockRealpath.mockImplementation(async (p: string) => {
      if (p === `${workspaceDir}/alias.md`) return `${workspaceDir}/real.md`;
      return p;
    });

    const resolved = await resolveWorkspacePath("alias.md", agentId, conversationId);
    expect(resolved).toBe(`${workspaceDir}/alias.md`);
  });

  it("handles a workspace dir that is itself a symlink", async () => {
    // Simulate macOS: /Users is actually /System/Volumes/Data/Users
    const aliasedWorkspace = "/System/Volumes/Data" + workspaceDir;
    mockRealpath.mockImplementation(async (p: string) => {
      if (p.startsWith(workspaceDir)) {
        return p.replace(workspaceDir, aliasedWorkspace);
      }
      return p;
    });

    const resolved = await resolveWorkspacePath("notes.md", agentId, conversationId);
    expect(resolved).toBe(`${workspaceDir}/notes.md`); // returns normalized, not realpath
    // and NO throw because realWorkspace and realTarget both map to aliased form
  });
});

describe("ensureWorkspaceDir", () => {
  it("calls mkdir with recursive:true on the workspace directory", async () => {
    mockMkdir.mockResolvedValue(undefined);
    const dir = await ensureWorkspaceDir("my-instance", "conv-1");
    expect(mockMkdir).toHaveBeenCalledWith(
      `${OA_SANDBOX_ROOT}/my-instance/conversations/conv-1`,
      { recursive: true },
    );
    expect(dir).toBe(`${OA_SANDBOX_ROOT}/my-instance/conversations/conv-1`);
  });

  it("sanitizes conversationId before creating directory", async () => {
    mockMkdir.mockResolvedValue(undefined);
    await ensureWorkspaceDir("my-instance", "foo:bar");
    expect(mockMkdir).toHaveBeenCalledWith(
      `${OA_SANDBOX_ROOT}/my-instance/conversations/foo_bar`,
      { recursive: true },
    );
  });
});

describe("assertInsideConversationWorkspace", () => {
  const agentId = "my-instance";
  const conversationId = "conv-1";
  const workspaceDir = `${OA_SANDBOX_ROOT}/${agentId}/conversations/${conversationId}`;

  it("accepts a path inside the workspace", async () => {
    await expect(
      assertInsideConversationWorkspace(`${workspaceDir}/.repos/owner/repo-abc/file.md`, agentId, conversationId),
    ).resolves.toBeUndefined();
  });

  it("accepts the workspace root itself", async () => {
    await expect(
      assertInsideConversationWorkspace(workspaceDir, agentId, conversationId),
    ).resolves.toBeUndefined();
  });

  it("rejects a path outside the workspace (another conversation)", async () => {
    await expect(
      assertInsideConversationWorkspace(
        `${OA_SANDBOX_ROOT}/${agentId}/conversations/other-conv/file.md`,
        agentId,
        conversationId,
      ),
    ).rejects.toThrow(/Access denied/);
  });

  it("rejects legacy .repos paths (which now live inside the workspace)", async () => {
    await expect(
      assertInsideConversationWorkspace(
        `/Users/foo/polyant/packages/engine/.repos/inst/owner/repo/file.md`,
        agentId,
        conversationId,
      ),
    ).rejects.toThrow(/Access denied/);
  });

  it("rejects system paths", async () => {
    await expect(
      assertInsideConversationWorkspace("/etc/passwd", agentId, conversationId),
    ).rejects.toThrow(/Access denied/);
  });

  it("rejects a path in a different instance's workspace", async () => {
    await expect(
      assertInsideConversationWorkspace(
        `${OA_SANDBOX_ROOT}/other-instance/conversations/conv-1/file`,
        agentId,
        conversationId,
      ),
    ).rejects.toThrow(/Access denied/);
  });

  it("blocks when realpath of an in-workspace path escapes (symlink attack)", async () => {
    mockRealpath.mockImplementation(async (p: string) => {
      if (p === `${workspaceDir}/evil`) return "/etc/passwd";
      return p;
    });

    await expect(
      assertInsideConversationWorkspace(`${workspaceDir}/evil`, agentId, conversationId),
    ).rejects.toThrow(/Access denied/);
  });
});
