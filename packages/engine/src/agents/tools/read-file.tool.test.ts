// SPDX-License-Identifier: AGPL-3.0-or-later

const mockReadFile = vi.hoisted(() => vi.fn());
const mockStat = vi.hoisted(() => vi.fn());
const mockRealpath = vi.hoisted(() => vi.fn(async (p: string) => p));

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: mockReadFile,
  stat: mockStat,
  realpath: mockRealpath,
}));
vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  stat: mockStat,
  realpath: mockRealpath,
}));
vi.mock("./registry.js", () => ({
  registerTool: vi.fn(),
}));
vi.mock("../../utils/error.js", () => ({
  errMsg: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

import { registerTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";
import { OA_SANDBOX_ROOT } from "./shared/workspace-utils.js";
import "./read-file.tool.js";

const def = vi.mocked(registerTool).mock.calls[0][0];

function buildTool(opts: { conversationId?: string | undefined } = { conversationId: "conv-1" }) {
  const ctx = {
    instanceId: "test-instance",
    secrets: {},
    audit: createMockAudit(),
    conversationId: opts.conversationId,
  } as any;
  return { execute: def.create(ctx).execute, audit: ctx.audit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRealpath.mockImplementation(async (p: string) => p);
});

const WORKSPACE_DIR = `${OA_SANDBOX_ROOT}/test-instance/conversations/conv-1`;

describe("readFile tool", () => {
  it("registers with correct metadata", () => {
    expect(def.name).toBe("readFile");
    expect(def.category).toBe("dev");
  });

  // ---- Workspace relative paths ----

  it("reads a file from the workspace using a relative path", async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 });
    mockReadFile.mockResolvedValue("# Hello\n\nThis is a readme.");
    const { execute } = buildTool();

    const result = await execute({ path: "notes.md", tail: null }) as { content: string; sizeBytes: number };

    expect(mockReadFile).toHaveBeenCalledWith(`${WORKSPACE_DIR}/notes.md`, "utf-8");
    expect(result.content).toBe("# Hello\n\nThis is a readme.");
    expect(result.sizeBytes).toBe(100);
  });

  it("reads a file inside the cloned repo (relative path to .repos)", async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 42 });
    mockReadFile.mockResolvedValue("readme content");
    const { execute } = buildTool();

    const result = await execute({ path: ".repos/owner/repo-abc123/README.md", tail: null }) as { content: string };

    expect(mockReadFile).toHaveBeenCalledWith(`${WORKSPACE_DIR}/.repos/owner/repo-abc123/README.md`, "utf-8");
    expect(result.content).toBe("readme content");
  });

  it("returns last N lines with tail option", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    mockStat.mockResolvedValue({ isFile: () => true, size: 1000 });
    mockReadFile.mockResolvedValue(lines.join("\n"));
    const { execute } = buildTool();

    const result = await execute({ path: "log.md", tail: 5 }) as { content: string };

    expect(result.content).toBe("Line 96\nLine 97\nLine 98\nLine 99\nLine 100");
  });

  it("blocks relative path traversal", async () => {
    const { execute } = buildTool();

    const result = await execute({ path: "../../../etc/passwd", tail: null }) as { error: string };

    expect(result.error).toContain("Access denied");
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  // ---- Absolute paths (must be inside the conversation workspace) ----

  it("reads a file with an absolute path inside the workspace (e.g. from gitCloneRepo output)", async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 10 });
    mockReadFile.mockResolvedValue("cloned");
    const absPath = `${WORKSPACE_DIR}/.repos/owner/repo-xyz/file.md`;
    const { execute } = buildTool();

    const result = await execute({ path: absPath, tail: null }) as { content: string };

    expect(mockReadFile).toHaveBeenCalledWith(absPath, "utf-8");
    expect(result.content).toBe("cloned");
  });

  it("blocks absolute paths outside the workspace", async () => {
    const { execute } = buildTool();

    const result = await execute({ path: "/etc/passwd", tail: null }) as { error: string };

    expect(result.error).toContain("Access denied");
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("blocks absolute paths belonging to another conversation's workspace", async () => {
    const otherPath = `${OA_SANDBOX_ROOT}/test-instance/conversations/other-conv/file.md`;
    const { execute } = buildTool();

    const result = await execute({ path: otherPath, tail: null }) as { error: string };

    expect(result.error).toContain("Access denied");
  });

  it("blocks absolute paths traversal attempts", async () => {
    const filePath = `${WORKSPACE_DIR}/../../../../etc/passwd`;
    const { execute } = buildTool();

    const result = await execute({ path: filePath, tail: null }) as { error: string };

    expect(result.error).toContain("Access denied");
  });

  // ---- Common behavior ----

  it("rejects files larger than 512 KB", async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 600 * 1024 });
    const { execute } = buildTool();

    const result = await execute({ path: "huge.bin", tail: null }) as { error: string };

    expect(result.error).toContain("File too large");
  });

  it("returns error for directories", async () => {
    mockStat.mockResolvedValue({ isFile: () => false });
    const { execute } = buildTool();

    const result = await execute({ path: "src", tail: null }) as { error: string };

    expect(result.error).toContain("is not a file");
  });

  it("truncates files longer than 500 lines", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}`);
    mockStat.mockResolvedValue({ isFile: () => true, size: 5000 });
    mockReadFile.mockResolvedValue(lines.join("\n"));
    const { execute } = buildTool();

    const result = await execute({ path: "big.txt", tail: null }) as { content: string; lines: number };

    expect(result.content).toContain("Line 1");
    expect(result.content).toContain("[... truncated:");
    expect(result.lines).toBe(600);
  });

  it("returns error when conversationId is missing", async () => {
    const { execute } = buildTool({ conversationId: undefined });

    const result = await execute({ path: "notes.md", tail: null }) as { error: string };

    expect(result.error).toMatch(/active conversation/i);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("logs audit on success with source=workspace-relative", async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 10 });
    mockReadFile.mockResolvedValue("hello");
    const { execute, audit } = buildTool();

    await execute({ path: "file.txt", tail: null });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.readFile",
        success: true,
        details: expect.objectContaining({ source: "workspace-relative" }),
      }),
    );
  });

  it("logs audit on success with source=workspace-absolute for abs paths inside workspace", async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 10 });
    mockReadFile.mockResolvedValue("hello");
    const { execute, audit } = buildTool();

    await execute({ path: `${WORKSPACE_DIR}/file.txt`, tail: null });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.readFile",
        success: true,
        details: expect.objectContaining({ source: "workspace-absolute" }),
      }),
    );
  });

  it("logs audit on error", async () => {
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const { execute, audit } = buildTool();

    await execute({ path: "missing.txt", tail: null });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.readFile", success: false }),
    );
  });
});
