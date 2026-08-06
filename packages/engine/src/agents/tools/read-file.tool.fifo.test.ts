// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Real-filesystem regression test for the TOCTOU-safe open in `readFile`.
 *
 * The type gate (`isFile()`) can only run AFTER the handle exists — that is the
 * whole point of the TOCTOU hardening — so a FIFO sitting inside the workspace
 * would block the tool in `open()` forever (a FIFO opened for reading waits for a
 * writer). `O_NONBLOCK` makes the open return immediately so the gate can reject it.
 *
 * Unlike `read-file.tool.test.ts` this file must NOT mock `fs/promises`: only a real
 * FIFO exercises the blocking behaviour. `mkfifo(2)`/`mkfifo(1)` exists on both
 * macOS and Linux, so this is portable on CI; the test is skipped on win32.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockAudit } from "../../test-utils.js";

const INSTANCE_ID = "fifo-instance";
const CONVERSATION_ID = "conv-fifo";

let root: string;
let workspaceDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tool: any;

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("readFile tool — FIFO inside the workspace", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "polyant-readfile-"));
    // `OA_WORKSPACES_ROOT` is captured at module load, so the env var must be set
    // before the tool (and workspace-utils) are imported.
    process.env.WORKSPACES_ROOT = root;
    workspaceDir = join(root, INSTANCE_ID, "conversations", CONVERSATION_ID);
    await mkdir(workspaceDir, { recursive: true });
    tool = (await import("./read-file.tool.js")).default;
  });

  afterAll(async () => {
    delete process.env.WORKSPACES_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  function execute(path: string) {
    return tool.execute(
      { path, tail: null },
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        secrets: {},
        audit: createMockAudit(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );
  }

  it("rejects a FIFO instead of blocking on open", async () => {
    execFileSync("mkfifo", [join(workspaceDir, "pipe")]);

    // No writer will ever open the other end. Without O_NONBLOCK this never settles;
    // the timeout below turns a regression into a failure instead of a hung suite.
    const result = await Promise.race([
      execute("pipe") as Promise<{ error?: string }>,
      new Promise<{ error: string }>((r) =>
        setTimeout(() => r({ error: "TIMEOUT: open() blocked on the FIFO" }), 3000),
      ),
    ]);

    expect(result.error).toContain("is not a file");
  }, 10_000);

  it("still reads a regular file (O_NONBLOCK does not change the normal path)", async () => {
    await writeFile(join(workspaceDir, "notes.md"), "hello\nworld");

    const result = (await execute("notes.md")) as { content: string; lines: number };

    expect(result.content).toBe("hello\nworld");
    expect(result.lines).toBe(2);
  });
});
