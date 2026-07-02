// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "child_process";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn().mockReturnValue("/tmp/askpass-dir"),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock("@/utils/pipeline-logger.js", () => ({
  pipelineLog: { toolCall: vi.fn(), toolResult: vi.fn() },
}));

import gitCloneRepoTool from "./git-clone-repo.tool.js";
import { buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

const mockExecFile = vi.mocked(execFile);
const toolCtx = { toolCallId: "tc-1", messages: [] } as any;

const dummyCtx = {
  instanceId: "test-instance",
  secrets: { github_token: "ghp_test123" },
  audit: createMockAudit(),
  conversationId: "conv-1",
} as any;

describe("gitCloneRepo", () => {
  const def = gitCloneRepoTool;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is registered with correct metadata", () => {
    expect(def).toBeDefined();
    expect(def.name).toBe("gitCloneRepo");
    expect(def.category).toBe("dev");
    expect(def.requiredSecrets.map((s) => s.key)).toContain("github_token");
  });

  it("clones repo fresh and returns path", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "abc1234", "");
      return {} as any;
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { repo: "owner/my-repo" },
      toolCtx,
    );

    expect(result.status).toBe("cloned");
    expect(result.path).toContain("owner/my-repo");
    const cloneCall = mockExecFile.mock.calls[0];
    expect(cloneCall[0]).toBe("git");
    expect((cloneCall[1] as string[])[0]).toBe("clone");
  });

  it("uses shallow clone (--depth 1)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "abc1234", "");
      return {} as any;
    });

    const tool = buildTool(def, dummyCtx) as any;
    await tool.execute({ repo: "owner/my-repo" }, toolCtx);

    const cloneArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(cloneArgs).toContain("--depth");
    expect(cloneArgs).toContain("1");
  });

  it("does not embed the GitHub token in clone arguments", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "abc1234", "");
      return {} as any;
    });

    const tool = buildTool(def, dummyCtx) as any;
    await tool.execute({ repo: "owner/my-repo" }, toolCtx);

    const cloneCall = mockExecFile.mock.calls[0];
    const cloneArgs = cloneCall[1] as string[];
    const cloneOpts = cloneCall[2] as { env?: Record<string, string> };

    expect(cloneArgs.join(" ")).not.toContain("ghp_test123");
    expect(cloneOpts.env?.OA_GITHUB_TOKEN).toBe("ghp_test123");
    expect(cloneOpts.env?.GIT_ASKPASS).toBe("/tmp/askpass-dir/askpass.sh");
  });

  it("returns error when github_token is missing", async () => {
    const noTokenCtx = { ...dummyCtx, secrets: {} } as any;
    const tool = buildTool(def, noTokenCtx) as any;
    const result = await tool.execute(
      { repo: "owner/my-repo" },
      toolCtx,
    );
    expect(result.error).toBeDefined();
  });

  it("returns error when conversationId is missing (no sandbox to clone into)", async () => {
    const noConvCtx = { ...dummyCtx, conversationId: undefined } as any;
    const tool = buildTool(def, noConvCtx) as any;
    const result = await tool.execute(
      { repo: "owner/my-repo" },
      toolCtx,
    );
    expect(result.error).toMatch(/active conversation/i);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("clones into the conversation workspace (.repos inside workspace)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "abc1234", "");
      return {} as any;
    });

    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute({ repo: "owner/my-repo" }, toolCtx);

    // Path should live under workspaces/{instanceId}/conversations/{convId}/.repos/
    expect(result.path).toContain("/workspaces/test-instance/conversations/conv-1/.repos/owner/my-repo-");
    expect(result.path).not.toContain("/.repos/test-instance/"); // old layout gone
  });

  it("validates repo format (owner/name)", async () => {
    const tool = buildTool(def, dummyCtx) as any;
    const result = await tool.execute(
      { repo: "invalid-no-slash" },
      toolCtx,
    );
    expect(result.error).toBeDefined();
  });
});
