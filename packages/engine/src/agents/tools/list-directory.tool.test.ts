// SPDX-License-Identifier: AGPL-3.0-or-later

const mockReaddir = vi.hoisted(() => vi.fn());
const mockStat = vi.hoisted(() => vi.fn());
const mockRealpath = vi.hoisted(() => vi.fn(async (p: string) => p));

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  readdir: mockReaddir,
  stat: mockStat,
  realpath: mockRealpath,
}));
vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  stat: mockStat,
  realpath: mockRealpath,
}));
vi.mock("../../utils/error.js", () => ({
  errMsg: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

import { createMockAudit } from "../../test-utils.js";
import { OA_WORKSPACES_ROOT } from "./shared/workspace-utils.js";
import def from "./list-directory.tool.js";

function buildTool(opts: { conversationId?: string | undefined } = { conversationId: "conv-1" }) {
  const ctx = {
    instanceId: "test-instance",
    secrets: {},
    audit: createMockAudit(),
    conversationId: opts.conversationId,
  } as any;
  return { execute: (input: any) => def.execute(input, ctx), audit: ctx.audit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRealpath.mockImplementation(async (p: string) => p);
});

const WORKSPACE_DIR = `${OA_WORKSPACES_ROOT}/test-instance/conversations/conv-1`;

describe("listDirectory tool", () => {
  it("registers with correct metadata", () => {
    expect(def.name).toBe("listDirectory");
    expect(def.category).toBe("dev");
  });

  // ---- Workspace relative paths ----

  it("lists the workspace root with '.'", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReaddir.mockResolvedValue([
      { name: "notes.md", isDirectory: () => false },
      { name: "output", isDirectory: () => true },
    ]);
    const { execute } = buildTool();

    const result = await execute({ path: "." }) as { path: string; entries: any[] };

    expect(result.path).toBe(WORKSPACE_DIR);
    expect(result.entries[0].name).toBe("output"); // dirs first
    expect(result.entries[1].name).toBe("notes.md");
  });

  it("lists a cloned repo directory via relative path", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReaddir.mockResolvedValue([
      { name: "README.md", isDirectory: () => false },
      { name: "src", isDirectory: () => true },
      { name: "_hot.md", isDirectory: () => false },
    ]);
    const { execute } = buildTool();

    const result = await execute({ path: ".repos/owner/repo-abc123" }) as { path: string; entries: any[]; totalEntries: number };

    expect(result.path).toBe(`${WORKSPACE_DIR}/.repos/owner/repo-abc123`);
    expect(result.entries[0]).toEqual({ name: "src", type: "directory" });
    expect(result.entries[1].name).toBe("_hot.md");
    expect(result.entries[2].name).toBe("README.md");
    expect(result.totalEntries).toBe(3);
  });

  it("filters hidden files (.git, etc.)", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReaddir.mockResolvedValue([
      { name: ".git", isDirectory: () => true },
      { name: ".gitignore", isDirectory: () => false },
      { name: "README.md", isDirectory: () => false },
    ]);
    const { execute } = buildTool();

    const result = await execute({ path: ".repos/owner/repo-abc123" }) as { entries: any[] };

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe("README.md");
  });

  it("blocks relative traversal outside the workspace", async () => {
    const { execute } = buildTool();

    const result = await execute({ path: "../../.." }) as { error: string };

    expect(result.error).toContain("Access denied");
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  // ---- Absolute paths (must be inside the conversation workspace) ----

  it("lists an absolute path inside the workspace", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReaddir.mockResolvedValue([]);
    const absPath = `${WORKSPACE_DIR}/.repos/owner/repo-xyz`;
    const { execute } = buildTool();

    const result = await execute({ path: absPath }) as { path: string };

    expect(result.path).toBe(absPath);
  });

  it("blocks absolute paths outside the workspace", async () => {
    const { execute } = buildTool();

    const result = await execute({ path: "/etc" }) as { error: string };

    expect(result.error).toContain("Access denied");
  });

  it("blocks absolute paths belonging to another conversation", async () => {
    const otherPath = `${OA_WORKSPACES_ROOT}/test-instance/conversations/other-conv`;
    const { execute } = buildTool();

    const result = await execute({ path: otherPath }) as { error: string };

    expect(result.error).toContain("Access denied");
  });

  // ---- Common behavior ----

  it("returns error for files (not directories)", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false });
    const { execute } = buildTool();

    const result = await execute({ path: "file.txt" }) as { error: string };

    expect(result.error).toContain("is not a directory");
  });

  it("returns error when conversationId is missing", async () => {
    const { execute } = buildTool({ conversationId: undefined });

    const result = await execute({ path: "." }) as { error: string };

    expect(result.error).toMatch(/active conversation/i);
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("logs audit on success with source=workspace-relative", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReaddir.mockResolvedValue([]);
    const { execute, audit } = buildTool();

    await execute({ path: "." });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.listDirectory",
        success: true,
        details: expect.objectContaining({ source: "workspace-relative" }),
      }),
    );
  });

  it("logs audit on success with source=workspace-absolute", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReaddir.mockResolvedValue([]);
    const { execute, audit } = buildTool();

    await execute({ path: `${WORKSPACE_DIR}/.repos` });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.listDirectory",
        success: true,
        details: expect.objectContaining({ source: "workspace-absolute" }),
      }),
    );
  });
});
