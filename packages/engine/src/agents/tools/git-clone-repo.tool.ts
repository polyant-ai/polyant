// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { execFile } from "child_process";
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { registerTool, type ToolContext } from "./registry.js";
import { safeEnv } from "./safe-env.js";
import { errMsg } from "../../utils/error.js";
import { getConversationWorkspaceDir } from "./shared/workspace-utils.js";

const GIT_TIMEOUT_MS = 120_000; // 2 minutes for clone/fetch
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours — repos older than this are stale

/**
 * Cloned repos live inside the per-conversation workspace under `.repos/`.
 * Layout: workspaces/{agentId}/conversations/{convId}/.repos/{owner}/{repo}-{suffix}/
 * This keeps all filesystem activity for a conversation inside a single sandbox.
 */
export function reposDirForConversation(agentId: string, conversationId: string): string {
  return join(getConversationWorkspaceDir(agentId, conversationId), ".repos");
}

/** Generate a short random session suffix (8 hex chars). */
function sessionSuffix(): string {
  return randomBytes(4).toString("hex");
}

function gitExec(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        env: safeEnv(opts.env),
        timeout: opts.timeout ?? GIT_TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: (stdout ?? "").trim(),
          stderr: (stderr ?? "").trim(),
          exitCode: error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

/** Resolve the local path for a cloned repo (with unique session suffix), scoped to a conversation. */
export function repoLocalPath(
  agentId: string,
  conversationId: string,
  repo: string,
  suffix?: string,
): string {
  const [owner, name] = repo.split("/");
  const dirName = suffix ? `${name}-${suffix}` : name;
  return join(reposDirForConversation(agentId, conversationId), owner, dirName);
}

/**
 * Remove stale repo directories for a conversation.
 * Directories older than STALE_THRESHOLD_MS are considered stale leftovers
 * from crashed/timed-out previous runs within the same conversation.
 *
 * SECURITY: each stale directory may still contain `.git/polyant-token` (a GitHub
 * access token used by the in-repo credential helper — see #87).  We warn
 * when we detect one because the presence past the stale threshold is a
 * signal that the cleanup contract was violated (likely a prior crash).
 */
export function cleanupStaleRepos(agentId: string, conversationId: string): void {
  const reposDir = reposDirForConversation(agentId, conversationId);
  if (!existsSync(reposDir)) return;

  const now = Date.now();
  try {
    for (const owner of readdirSync(reposDir)) {
      const ownerDir = join(reposDir, owner);
      try {
        if (!statSync(ownerDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const repoDir of readdirSync(ownerDir)) {
        const fullPath = join(ownerDir, repoDir);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory() && now - stat.mtimeMs > STALE_THRESHOLD_MS) {
            const tokenPath = join(fullPath, ".git", "polyant-token");
            if (existsSync(tokenPath)) {
              console.warn(
                `[gitCloneRepo] Stale workspace contains leftover credential token: ${tokenPath} — cleaning up now`,
              );
            }
            console.log(`[gitCloneRepo] Removing stale workspace: ${fullPath}`);
            forceRemove(fullPath);
          }
        } catch {
          // skip unreadable entries
        }
      }
    }
  } catch {
    // best-effort
  }
}

/** Clone a repo fresh with unique session path. Returns path or error. */
export async function cloneRepoFresh(
  repo: string,
  token: string,
  agentId: string,
  conversationId: string,
  branch?: string | null,
): Promise<{ path: string; branch: string; lastCommit: string } | { error: string }> {
  if (!repo.includes("/") || repo.split("/").length !== 2) {
    return { error: `Invalid repo format: "${repo}". Expected "owner/name".` };
  }

  const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;
  const [owner, name] = repo.split("/");
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(name)) {
    return { error: `Invalid repo name: owner and name must match [a-zA-Z0-9._-].` };
  }

  // SECURITY: validate `branch` the same way as repo segments and reject any
  // value starting with `-`. `execFile` blocks shell injection but git itself
  // parses `--upload-pack=<path>` as a flag from the next positional argument,
  // which would let a prompt-injected LLM achieve arbitrary code execution by
  // setting branch to e.g. `--upload-pack=/usr/bin/curl ...`.
  if (branch !== undefined && branch !== null) {
    if (branch.startsWith("-") || !SAFE_SEGMENT.test(branch)) {
      return {
        error: `Invalid branch name: must match [a-zA-Z0-9._-] and not start with "-".`,
      };
    }
  }

  // Clean up stale workspaces from previous crashed/timed-out runs in this conversation
  cleanupStaleRepos(agentId, conversationId);

  const suffix = sessionSuffix();
  const basePath = repoLocalPath(agentId, conversationId, repo, suffix);

  console.log(`[gitCloneRepo] Preparing workspace ${basePath}`);
  if (existsSync(basePath)) {
    forceRemove(basePath);
  }
  mkdirSync(basePath, { recursive: true });

  console.log(`[gitCloneRepo] Cloning ${repo}${branch ? ` (branch: ${branch})` : ""} → ${basePath}`);
  const cloneUrl = `https://github.com/${repo}.git`;
  const cloneArgs = ["clone", "--depth", "1"];
  if (branch) {
    cloneArgs.push("--branch", branch);
  }
  cloneArgs.push(cloneUrl, basePath);

  const askPassDir = mkdtempSync(join(tmpdir(), "polyant-git-askpass-"));
  const askPassPath = join(askPassDir, "askpass.sh");
  writeFileSync(
    askPassPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      '  *) printf "%s\\n" "$OA_GITHUB_TOKEN" ;;',
      "esac",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(askPassPath, 0o700);

  let cloneResult;
  try {
    cloneResult = await gitExec(cloneArgs, {
      env: {
        GIT_ASKPASS: askPassPath,
        GIT_TERMINAL_PROMPT: "0",
        OA_GITHUB_TOKEN: token,
      },
    });
  } finally {
    rmSync(askPassDir, { recursive: true, force: true });
  }
  if (cloneResult.exitCode !== 0) {
    console.error(`[gitCloneRepo] Clone failed: ${cloneResult.stderr}`);
    return { error: `git clone failed: ${cloneResult.stderr}` };
  }

  // Configure persistent git credentials for subsequent push/pull within the repo
  // (e.g. by Claude Code CLI).  Both the token file and the helper script live inside
  // .git/ so they are co-located with the repo and are deleted automatically when
  // cleanupRepo() removes the repo directory.  Storing them in a tmpdir and then
  // deleting that tmpdir in a finally block left .git/config with a dangling
  // credential.helper reference, causing all subsequent git auth operations to fail.
  const tokenPath = join(basePath, ".git", "polyant-token");
  const helperPath = join(basePath, ".git", "polyant-askpass.sh");

  writeFileSync(tokenPath, token, { mode: 0o600 });
  writeFileSync(
    helperPath,
    [
      "#!/bin/sh",
      "echo protocol=https",
      "echo host=github.com",
      'echo username=x-access-token',
      `echo password=$(cat "${tokenPath}")`,
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(helperPath, 0o700);

  await gitExec(["config", "credential.helper", `!${helperPath}`], { cwd: basePath });

  const headResult = await gitExec(["rev-parse", "--short", "HEAD"], { cwd: basePath });
  const branchResult = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: basePath });

  console.log(`[gitCloneRepo] ✓ Cloned ${repo} @ ${branchResult.stdout} (${headResult.stdout}) → ${basePath}`);

  return {
    path: basePath,
    branch: branchResult.stdout,
    lastCommit: headResult.stdout,
  };
}

/**
 * Force-remove a directory, handling ENOTEMPTY / EBUSY by retrying.
 * Git .git/objects/pack files can cause rmSync to fail on first attempt.
 */
function forceRemove(dirPath: string, retries = 3): void {
  for (let i = 0; i < retries; i++) {
    try {
      rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
        // Wait briefly and retry — OS may release file locks
        const delayMs = 500 * (i + 1);
        console.warn(`[gitCloneRepo] ${code} removing ${dirPath}, retry ${i + 1}/${retries} after ${delayMs}ms`);
        const start = Date.now();
        while (Date.now() - start < delayMs) { /* busy-wait — sync context */ }
        continue;
      }
      throw err;
    }
  }
  // Final attempt — let it throw if still failing
  rmSync(dirPath, { recursive: true, force: true });
}

/** Cleanup a cloned repo directory. */
export function cleanupRepo(path: string): void {
  try {
    if (existsSync(path)) {
      forceRemove(path);
      console.log(`[gitCloneRepo] Cleaned up ${path}`);
    }
  } catch (err) {
    console.warn(`[gitCloneRepo] Cleanup failed for ${path}: ${errMsg(err)}`);
    // Best-effort — don't throw
  }
}

registerTool({
  name: "gitCloneRepo",
  description:
    "Clone a GitHub repository to work with it locally (fresh clone every time).\n" +
    "Use only when you need to work on the repo with multiple tools in sequence. Returns the local path.\n" +
    "Do NOT use for remote GitHub operations (issues, PRs) — use the dedicated `gh*` tools.\n" +
    "Returns the local path of the cloned repository.\n" +
    "Caveat: each call performs a fresh clone. The default branch is the repo's main branch. Clone timeout: 2 minutes.",
  category: "dev",
  requiredSecrets: ["github_token"],
  create: (ctx: ToolContext) => ({
    parameters: z.object({
      repo: z
        .string()
        .describe("GitHub repository in `owner/name` format (e.g. 'anthropics/claude-code')."),
      branch: z
        .string()
        .nullable()
        .describe("Branch to use (default: the repo's default branch)."),
    }),
    execute: async ({ repo, branch }: { repo: string; branch: string | null }) => {
      const token = ctx.secrets?.github_token;
      if (!token) {
        return { error: "GitHub token not configured for this agent." };
      }
      if (!ctx.conversationId) {
        return { error: "gitCloneRepo requires an active conversation (conversationId missing from context)." };
      }

      const startMs = Date.now();

      try {
        const result = await cloneRepoFresh(repo, token, ctx.agentId, ctx.conversationId, branch);
        const durationMs = Date.now() - startMs;

        if ("error" in result) {
          ctx.audit.log({ action: "dev.gitClone", details: { repo }, success: false, error: result.error });
          return { error: result.error };
        }

        ctx.audit.log({ action: "dev.gitClone", details: { repo, status: "cloned", durationMs }, success: true });

        return { ...result, status: "cloned" as const, durationMs };
      } catch (err) {
        const message = errMsg(err);
        ctx.audit.log({ action: "dev.gitClone", details: { repo }, success: false, error: message });
        return { error: message };
      }
    },
  }),
});
