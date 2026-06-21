// SPDX-License-Identifier: AGPL-3.0-or-later

const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockStat = vi.hoisted(() => vi.fn());
const mockRealpath = vi.hoisted(() => vi.fn(async (p: string) => p));

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  stat: mockStat,
  realpath: mockRealpath,
}));
vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  stat: mockStat,
  realpath: mockRealpath,
}));
vi.mock("./registry.js", () => ({
  registerTool: vi.fn(),
}));
vi.mock("../../utils/error.js", () => ({
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { registerTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";
import { OA_SANDBOX_ROOT } from "./shared/workspace-utils.js";
import "./write-file.tool.js";

const def = vi.mocked(registerTool).mock.calls[0][0];

function buildTool(opts: { conversationId?: string | undefined } = { conversationId: "conv-1" }) {
  const ctx = {
    agentId: "test-instance",
    secrets: {},
    audit: createMockAudit(),
    conversationId: opts.conversationId,
  } as any;
  return { execute: def.create(ctx).execute, audit: ctx.audit };
}

const WORKSPACE = `${OA_SANDBOX_ROOT}/test-instance/conversations/conv-1`;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: file does not exist (stat throws ENOENT)
  mockStat.mockRejectedValue(new Error("ENOENT"));
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRealpath.mockImplementation(async (p: string) => p);
});

describe("writeFile tool", () => {
  it("registers with correct metadata", () => {
    expect(def.name).toBe("writeFile");
    expect(def.category).toBe("workspace");
  });

  it("writes a file to the workspace at a relative path", async () => {
    const { execute } = buildTool();

    const result = await execute({
      path: "notes.md",
      content: "hello world",
      overwrite: true,
    }) as { path: string; sizeBytes: number; created: boolean };

    expect(result.created).toBe(true);
    expect(result.path).toBe("notes.md");
    expect(result.sizeBytes).toBe(11); // "hello world" in UTF-8
    expect(mockWriteFile).toHaveBeenCalledWith(
      `${WORKSPACE}/notes.md`,
      "hello world",
      "utf-8",
    );
  });

  it("creates parent directories for nested paths", async () => {
    const { execute } = buildTool();

    await execute({
      path: "output/reports/final.md",
      content: "report",
      overwrite: true,
    });

    expect(mockMkdir).toHaveBeenCalledWith(
      `${WORKSPACE}/output/reports`,
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      `${WORKSPACE}/output/reports/final.md`,
      "report",
      "utf-8",
    );
  });

  it("blocks path traversal attempts", async () => {
    const { execute } = buildTool();

    const result = await execute({
      path: "../../../etc/evil",
      content: "bad",
      overwrite: true,
    }) as { error: string };

    expect(result.error).toMatch(/Access denied/);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("blocks absolute paths", async () => {
    const { execute } = buildTool();

    const result = await execute({
      path: "/etc/passwd",
      content: "bad",
      overwrite: true,
    }) as { error: string };

    expect(result.error).toMatch(/only accepts relative paths/);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("blocks null bytes in path", async () => {
    const { execute } = buildTool();

    const result = await execute({
      path: "foo\0bar.txt",
      content: "x",
      overwrite: true,
    }) as { error: string };

    expect(result.error).toMatch(/null byte/);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns error when conversationId is missing", async () => {
    const { execute } = buildTool({ conversationId: undefined });

    const result = await execute({
      path: "notes.md",
      content: "x",
      overwrite: true,
    }) as { error: string };

    expect(result.error).toMatch(/active conversation/i);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("refuses to overwrite existing file when overwrite=false", async () => {
    // File exists
    mockStat.mockResolvedValue({ isFile: () => true, size: 10 });
    const { execute } = buildTool();

    const result = await execute({
      path: "notes.md",
      content: "new content",
      overwrite: false,
    }) as { error: string };

    expect(result.error).toMatch(/already exists/);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("overwrites existing file when overwrite=true", async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 10 });
    const { execute } = buildTool();

    const result = await execute({
      path: "notes.md",
      content: "new content",
      overwrite: true,
    }) as { created: boolean };

    expect(result.created).toBe(true);
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("defaults to overwrite=true when not specified", async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 10 });
    const { execute } = buildTool();

    const result = await execute({
      path: "notes.md",
      content: "new content",
    }) as { created: boolean };

    expect(result.created).toBe(true);
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("logs audit on success", async () => {
    const { execute, audit } = buildTool();

    await execute({ path: "notes.md", content: "x", overwrite: true });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.writeFile",
        success: true,
        details: expect.objectContaining({ path: "notes.md", sizeBytes: 1 }),
      }),
    );
  });

  it("logs audit on error (traversal)", async () => {
    const { execute, audit } = buildTool();

    await execute({ path: "../../evil", content: "x", overwrite: true });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.writeFile",
        success: false,
      }),
    );
  });

  it("logs audit on error (write failure)", async () => {
    mockWriteFile.mockRejectedValue(new Error("EACCES: permission denied"));
    const { execute, audit } = buildTool();

    await execute({ path: "notes.md", content: "x", overwrite: true });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.writeFile",
        success: false,
        error: expect.stringContaining("EACCES"),
      }),
    );
  });

  it("sanitizes conversationId with unsafe chars for directory layout", async () => {
    const ctx = {
      agentId: "test-instance",
      secrets: {},
      audit: createMockAudit(),
      conversationId: "inst:web:chat-1",
    } as any;
    const execute = def.create(ctx).execute;

    await execute({ path: "notes.md", content: "x", overwrite: true });

    expect(mockWriteFile).toHaveBeenCalledWith(
      `${OA_SANDBOX_ROOT}/test-instance/conversations/inst_web_chat-1/notes.md`,
      "x",
      "utf-8",
    );
  });
});
