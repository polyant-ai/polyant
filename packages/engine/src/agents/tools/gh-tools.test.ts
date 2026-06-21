// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock gh-exec before importing tools — use vi.hoisted to avoid TDZ
const { mockGhJson, mockGhExec } = vi.hoisted(() => ({
  mockGhJson: vi.fn(),
  mockGhExec: vi.fn(),
}));
vi.mock("./gh-exec.js", () => ({
  ghJson: mockGhJson,
  ghExec: mockGhExec,
}));

vi.mock("@/utils/pipeline-logger.js", () => ({
  pipelineLog: { toolCall: vi.fn(), toolResult: vi.fn() },
}));

// Import consolidated gh tools (triggers registerTool side effects)
import "./gh-pr.tool.js";
import "./gh-issue.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

const toolCtx = { toolCallId: "tc-1", messages: [] } as any;
const dummyCtx = {
  agentId: "test-instance",
  secrets: { github_token: "ghp_test" },
  audit: createMockAudit(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

/* ================================================================== */
/*  ghIssue                                                           */
/* ================================================================== */

describe("ghIssue", () => {
  const def = getToolRegistry().get("ghIssue")!;

  it("is registered with correct metadata", () => {
    expect(def).toBeDefined();
    expect(def.category).toBe("dev");
    expect(def.requiredSecrets).toContain("github_token");
  });

  it("search: returns parsed issue list", async () => {
    mockGhJson.mockResolvedValue({
      data: [
        { number: 1, title: "Bug fix", state: "OPEN", author: { login: "user1" } },
        { number: 2, title: "Feature", state: "OPEN", author: { login: "user2" } },
      ],
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "search", repo: "owner/repo", query: null, state: null, labels: null, limit: null },
      toolCtx,
    );

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].number).toBe(1);
  });

  it("get: returns issue details with comments", async () => {
    mockGhJson.mockResolvedValue({
      data: { number: 42, title: "Bug", body: "Description", comments: [] },
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "get", repo: "owner/repo", number: 42 },
      toolCtx,
    );

    expect(result.issue.number).toBe(42);
  });

  it("create: creates issue and returns URL", async () => {
    mockGhExec.mockResolvedValue({
      stdout: "https://github.com/owner/repo/issues/10",
      stderr: "",
      exitCode: 0,
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "create", repo: "owner/repo", title: "New bug", body: "Details here", labels: null, assignee: null },
      toolCtx,
    );

    expect(result.url).toContain("issues/10");
  });

  it("comment: posts comment and returns success", async () => {
    mockGhExec.mockResolvedValue({
      stdout: "https://github.com/owner/repo/issues/5#issuecomment-123",
      stderr: "",
      exitCode: 0,
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "comment", repo: "owner/repo", number: 5, body: "Thanks for reporting" },
      toolCtx,
    );

    expect(result.success).toBe(true);
  });

  it("returns error when token is missing", async () => {
    const noToken = { ...dummyCtx, secrets: {} } as any;
    const tool = buildTool(def, noToken) as any;
    const result = await tool.execute(
      { action: "search", repo: "owner/repo", query: null, state: null, labels: null, limit: null },
      toolCtx,
    );
    expect(result.error).toBeDefined();
  });
});

/* ================================================================== */
/*  ghPR                                                              */
/* ================================================================== */

describe("ghPR", () => {
  const def = getToolRegistry().get("ghPR")!;

  it("is registered with correct metadata", () => {
    expect(def).toBeDefined();
    expect(def.category).toBe("dev");
    expect(def.requiredSecrets).toContain("github_token");
  });

  it("list: returns PR list", async () => {
    mockGhJson.mockResolvedValue({
      data: [{ number: 10, title: "feat: add X", state: "OPEN" }],
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "list", repo: "owner/repo", state: null, author: null, base: null, limit: null },
      toolCtx,
    );

    expect(result.pullRequests).toHaveLength(1);
  });

  it("get: returns PR details without diff by default", async () => {
    mockGhJson.mockResolvedValue({
      data: { number: 10, title: "feat: add X", additions: 50, deletions: 10 },
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "get", repo: "owner/repo", number: 10, includeDiff: null },
      toolCtx,
    );

    expect(result.pr.number).toBe(10);
    expect(result.diff).toBeUndefined();
  });

  it("get: includes diff when requested", async () => {
    mockGhJson.mockResolvedValue({
      data: { number: 10, title: "feat: add X" },
    });
    mockGhExec.mockResolvedValue({
      stdout: "diff --git a/file.ts b/file.ts\n+new line",
      stderr: "",
      exitCode: 0,
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "get", repo: "owner/repo", number: 10, includeDiff: true },
      toolCtx,
    );

    expect(result.diff).toContain("+new line");
  });

  it("create: creates PR and returns URL", async () => {
    mockGhExec.mockResolvedValue({
      stdout: "https://github.com/owner/repo/pull/15",
      stderr: "",
      exitCode: 0,
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "create", repo: "owner/repo", title: "feat: add X", body: "Description", head: "feat/x", base: null, draft: null },
      toolCtx,
    );

    expect(result.url).toContain("pull/15");
  });

  it("review: submits review", async () => {
    mockGhExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "review", repo: "owner/repo", number: 10, event: "COMMENT", body: "Looks good" },
      toolCtx,
    );

    expect(result.success).toBe(true);
  });

  it("comment: posts PR comment", async () => {
    mockGhExec.mockResolvedValue({
      stdout: "https://github.com/owner/repo/pull/10#issuecomment-456",
      stderr: "",
      exitCode: 0,
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { action: "comment", repo: "owner/repo", number: 10, body: "Nice work" },
      toolCtx,
    );

    expect(result.success).toBe(true);
  });

  it("returns error when token is missing", async () => {
    const noToken = { ...dummyCtx, secrets: {} } as any;
    const tool = buildTool(def, noToken) as any;
    const result = await tool.execute(
      { action: "list", repo: "owner/repo", state: null, author: null, base: null, limit: null },
      toolCtx,
    );
    expect(result.error).toBeDefined();
  });
});
