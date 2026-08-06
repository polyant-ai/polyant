// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration-style unit tests for the symlink defense of the workspace sandbox.
 *
 * These tests use REAL filesystem operations (fs.symlinkSync, fs.realpath) in a
 * tmpdir. Mocking fs/promises here would defeat the point — we need to verify
 * that symlinks created on a real disk are actually blocked by the realpath
 * check inside resolveWorkspacePath / assertInsideConversationWorkspace.
 *
 * Pattern: override SANDBOX_ROOT via env var so getConversationWorkspaceDir
 * resolves inside our tmpdir. Must set the env var BEFORE the workspace-utils
 * module is first imported (the constant is computed at module load).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Set SANDBOX_ROOT before importing workspace-utils
const TEST_SANDBOX_ROOT = mkdtempSync(join(tmpdir(), "oa-symlink-test-"));
process.env.SANDBOX_ROOT = TEST_SANDBOX_ROOT;

// Now import — OA_SANDBOX_ROOT will pick up our env var
const {
  resolveWorkspacePath,
  assertInsideConversationWorkspace,
  ensureWorkspaceDir,
  OA_SANDBOX_ROOT,
} = await import("./workspace-utils.js");

const INSTANCE = "sl-inst";
const CONV = "sl-conv";

// realpath the tmpdir because macOS /tmp → /private/tmp. The functions return
// normalized (non-realpath) paths; here we just need a valid workspace dir.
const workspaceDir = resolve(OA_SANDBOX_ROOT, INSTANCE, "conversations", CONV);

beforeAll(async () => {
  await ensureWorkspaceDir(INSTANCE, CONV);
});

beforeEach(() => {
  // Clean workspace contents between tests (but keep the dir itself)
  // Only rm entries we know we created — avoid nuking the whole dir accidentally.
});

afterAll(() => {
  // Clean up the whole tmp workspaces root
  try {
    rmSync(TEST_SANDBOX_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  delete process.env.SANDBOX_ROOT;
});

describe("symlink safety — real filesystem", () => {
  describe("resolveWorkspacePath with real symlinks", () => {
    it("blocks a relative path that resolves via symlink to outside (/etc/passwd)", async () => {
      const outsideTarget = "/etc/passwd";
      const linkPath = join(workspaceDir, "evil_escape");
      try { rmSync(linkPath, { force: true }); } catch { /* ignore */ }
      symlinkSync(outsideTarget, linkPath);

      await expect(
        resolveWorkspacePath("evil_escape", INSTANCE, CONV),
      ).rejects.toThrow(/Access denied/);
    });

    it("blocks a symlink pointing to /tmp (outside workspace)", async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "oa-outside-"));
      const outsideFile = join(outsideDir, "secret.txt");
      writeFileSync(outsideFile, "secret");

      const linkPath = join(workspaceDir, "escape_link");
      try { rmSync(linkPath, { force: true }); } catch { /* ignore */ }
      symlinkSync(outsideFile, linkPath);

      await expect(
        resolveWorkspacePath("escape_link", INSTANCE, CONV),
      ).rejects.toThrow(/Access denied/);

      // cleanup the outside dir
      rmSync(outsideDir, { recursive: true, force: true });
    });

    it("blocks a symlink directory that escapes when traversed", async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "oa-outside-dir-"));
      writeFileSync(join(outsideDir, "inside-victim.txt"), "victim");

      const linkDir = join(workspaceDir, "escape_dir");
      try { rmSync(linkDir, { force: true }); } catch { /* ignore */ }
      symlinkSync(outsideDir, linkDir);

      // Try to reach the file inside the outside dir via the symlinked directory
      await expect(
        resolveWorkspacePath("escape_dir/inside-victim.txt", INSTANCE, CONV),
      ).rejects.toThrow(/Access denied/);

      rmSync(outsideDir, { recursive: true, force: true });
    });

    it("ACCEPTS a symlink that resolves to another file INSIDE the workspace", async () => {
      const realFile = join(workspaceDir, "real_target.txt");
      writeFileSync(realFile, "ok");

      const linkPath = join(workspaceDir, "inside_alias");
      try { rmSync(linkPath, { force: true }); } catch { /* ignore */ }
      symlinkSync(realFile, linkPath);

      const resolved = await resolveWorkspacePath("inside_alias", INSTANCE, CONV);
      expect(resolved).toBe(join(workspaceDir, "inside_alias"));
    });

    it("allows writing a new file when the workspace dir root is valid (non-existent target)", async () => {
      // Path does not exist yet (writeFile scenario). Should not throw.
      const resolved = await resolveWorkspacePath("new-file-" + Date.now() + ".txt", INSTANCE, CONV);
      expect(resolved.startsWith(workspaceDir)).toBe(true);
    });

    it("blocks creating a new file under a symlinked parent dir that escapes", async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "oa-parent-escape-"));

      const linkDir = join(workspaceDir, "escape_parent");
      try { rmSync(linkDir, { force: true }); } catch { /* ignore */ }
      symlinkSync(outsideDir, linkDir);

      // target file does not exist, but its parent is a symlink escaping the sandbox
      await expect(
        resolveWorkspacePath("escape_parent/new_file.txt", INSTANCE, CONV),
      ).rejects.toThrow(/Access denied/);

      rmSync(outsideDir, { recursive: true, force: true });
    });
  });

  describe("assertInsideConversationWorkspace with real symlinks", () => {
    it("blocks an absolute path that is a symlink escaping the workspace", async () => {
      const linkPath = join(workspaceDir, "abs_escape");
      try { rmSync(linkPath, { force: true }); } catch { /* ignore */ }
      symlinkSync("/etc/passwd", linkPath);

      await expect(
        assertInsideConversationWorkspace(linkPath, INSTANCE, CONV),
      ).rejects.toThrow(/Access denied/);
    });

    it("accepts an absolute path whose realpath stays inside the workspace", async () => {
      const subDir = join(workspaceDir, "subdir");
      mkdirSync(subDir, { recursive: true });
      const realFile = join(subDir, "real.txt");
      writeFileSync(realFile, "ok");

      await expect(
        assertInsideConversationWorkspace(realFile, INSTANCE, CONV),
      ).resolves.toBeUndefined();
    });
  });
});
