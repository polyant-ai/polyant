// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "./registry.js";
import { ghExec, ghJson } from "./gh-exec.js";
import { errMsg } from "../../utils/error.js";

const MAX_DIFF_SIZE = 50_000; // 50KB

const EVENT_FLAGS: Record<string, string> = {
  APPROVE: "--approve",
  REQUEST_CHANGES: "--request-changes",
  COMMENT: "--comment",
};

async function handleCreate(
  ctx: ToolContext,
  token: string,
  { repo, title, body, head, base, draft }: { repo: string; title: string; body: string; head: string; base: string | null; draft: boolean | null },
) {
  try {
    const args = ["pr", "create", "-R", repo, "--title", title, "--body", body, "--head", head, "--base", base ?? "main"];
    if (draft) args.push("--draft");

    const result = await ghExec(args, token);
    if (result.exitCode !== 0) {
      ctx.audit.log({ action: "dev.ghCreatePR", details: { repo, title }, success: false, error: result.stderr });
      return { error: result.stderr };
    }

    ctx.audit.log({ action: "dev.ghCreatePR", details: { repo, title, head }, success: true });
    return { success: true, url: result.stdout.trim() };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghCreatePR", details: { repo }, success: false, error: message });
    return { error: message };
  }
}

async function handleGet(
  ctx: ToolContext,
  token: string,
  { repo, number, includeDiff }: { repo: string; number: number; includeDiff: boolean | null },
) {
  try {
    const result = await ghJson(
      ["pr", "view", String(number), "-R", repo, "--json", "number,title,body,state,author,headRefName,baseRefName,files,comments,reviews,additions,deletions,commits"],
      token,
    );
    if ("error" in result) {
      ctx.audit.log({ action: "dev.ghGetPR", details: { repo, number }, success: false, error: result.error });
      return { error: result.error };
    }

    let diff: string | undefined;
    if (includeDiff) {
      const diffResult = await ghExec(["pr", "diff", String(number), "-R", repo], token);
      if (diffResult.exitCode === 0) {
        diff = diffResult.stdout.length > MAX_DIFF_SIZE
          ? diffResult.stdout.slice(0, MAX_DIFF_SIZE) + "\n... [diff truncated at 50KB]"
          : diffResult.stdout;
      }
    }

    ctx.audit.log({ action: "dev.ghGetPR", details: { repo, number, hasDiff: !!diff }, success: true });
    return { pr: result.data, ...(diff !== undefined && { diff }) };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghGetPR", details: { repo, number }, success: false, error: message });
    return { error: message };
  }
}

async function handleComment(
  ctx: ToolContext,
  token: string,
  { repo, number, body }: { repo: string; number: number; body: string },
) {
  try {
    const result = await ghExec(
      ["pr", "comment", String(number), "-R", repo, "--body", body],
      token,
    );
    if (result.exitCode !== 0) {
      ctx.audit.log({ action: "dev.ghCommentPR", details: { repo, number }, success: false, error: result.stderr });
      return { error: result.stderr };
    }

    ctx.audit.log({ action: "dev.ghCommentPR", details: { repo, number }, success: true });
    return { success: true, url: result.stdout.trim() };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghCommentPR", details: { repo, number }, success: false, error: message });
    return { error: message };
  }
}

async function handleList(
  ctx: ToolContext,
  token: string,
  { repo, state, author, base, limit }: { repo: string; state: "open" | "closed" | "merged" | "all" | null; author: string | null; base: string | null; limit: number | null },
) {
  try {
    const effectiveLimit = limit ?? 100;
    const args = ["pr", "list", "-R", repo, "--json", "number,title,state,author,headRefName,baseRefName,createdAt,updatedAt,isDraft,mergeable", "--limit", String(effectiveLimit)];
    if (state) args.push("--state", state);
    if (author) args.push("--author", author);
    if (base) args.push("--base", base);

    const result = await ghJson<unknown[]>(args, token);
    if ("error" in result) {
      ctx.audit.log({ action: "dev.ghListPRs", details: { repo }, success: false, error: result.error });
      return { error: result.error };
    }

    const count = result.data.length;
    ctx.audit.log({ action: "dev.ghListPRs", details: { repo, resultCount: count }, success: true });
    return {
      pullRequests: result.data,
      count,
      ...(count === effectiveLimit ? { truncated: true, hint: `Returned exactly ${effectiveLimit} results — there may be more. Call again with a higher limit.` } : {}),
    };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghListPRs", details: { repo }, success: false, error: message });
    return { error: message };
  }
}

async function handleReview(
  ctx: ToolContext,
  token: string,
  { repo, number, event, body }: { repo: string; number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
) {
  try {
    const result = await ghExec(
      ["pr", "review", String(number), "-R", repo, EVENT_FLAGS[event], "--body", body],
      token,
    );
    if (result.exitCode !== 0) {
      ctx.audit.log({ action: "dev.ghReviewPR", details: { repo, number, event }, success: false, error: result.stderr });
      return { error: result.stderr };
    }

    ctx.audit.log({ action: "dev.ghReviewPR", details: { repo, number, event }, success: true });
    return { success: true, event };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghReviewPR", details: { repo, number }, success: false, error: message });
    return { error: message };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool registration                                                  */
/* ------------------------------------------------------------------ */

export default defineTool({
  name: "ghPR",
  description:
    "Manage GitHub pull requests: create, read details, comment, list, or submit a review.\n" +
    "Available actions:\n" +
    "- create: Create a new PR. The head branch must already be pushed to the remote. `base` is optional (default: main). Draft PRs do not notify reviewers.\n" +
    "- get: Retrieve full PR details (title, body, state, reviewers, files). Use `includeDiff: true` to inspect changes (truncated at 50KB).\n" +
    "- comment: Add a general comment to a PR (not a formal review). Supports Markdown.\n" +
    "- list: List PRs with filters for state (open/closed/merged/all), author, and base branch. Default limit 100, recommended max 500.\n" +
    "- review: Submit a formal review (APPROVE, REQUEST_CHANGES, COMMENT). APPROVE and REQUEST_CHANGES change the PR state.\n" +
    "Do NOT use for issues — use `ghIssue`.",
  category: "dev",
  requiredSecrets: ["github_token"],
  inputExamples: [
    {
      label: "Create PR",
      input: { action: "create", repo: "owner/repo", title: "feat: add login validation", body: "Added input validation to the login form", head: "feat/login-validation" },
    },
    {
      label: "PR details with diff",
      input: { action: "get", repo: "owner/repo", number: 42, includeDiff: true },
    },
    {
      label: "List open PRs",
      input: { action: "list", repo: "owner/repo", state: "open" },
    },
    {
      label: "Approve PR with review",
      input: { action: "review", repo: "owner/repo", number: 42, event: "APPROVE", body: "LGTM, great work!" },
    },
  ],
  parameters: z.object({
      action: z.enum(["create", "get", "comment", "list", "review"]).describe("Action to perform on the PR."),
      repo: z.string().describe("Repository in `owner/name` format."),
      number: z.number().nullable().describe("PR number (required for `get`, `comment`, `review`)."),
      title: z.string().nullable().describe("PR title (required for `create`)."),
      body: z.string().nullable().describe("Description or comment (required for `create`, `comment`, `review`). Supports Markdown."),
      head: z.string().nullable().describe("Source branch (required for `create`, e.g. 'feat/my-feature')."),
      base: z.string().nullable().describe("Target branch for `create` (default: main). Filters by base branch in `list`."),
      draft: z.boolean().nullable().describe("If true, create as a draft PR (only for `create`)."),
      includeDiff: z.boolean().nullable().describe("If true, include the diff in the response (only for `get`, truncated at 50KB)."),
      state: z.enum(["open", "closed", "merged", "all"]).nullable().describe("Filter by state (only for `list`, default: open)."),
      author: z.string().nullable().describe("Filter by author (only for `list`)."),
      limit: z.number().nullable().describe("Maximum number of results (only for `list`, default: 100, recommended max: 500)."),
      event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).nullable().describe("Review type (required for `review`)."),
    }),
  execute: async (params: {
      action: "create" | "get" | "comment" | "list" | "review";
      repo: string;
      number?: number | null;
      title?: string | null;
      body?: string | null;
      head?: string | null;
      base?: string | null;
      draft?: boolean | null;
      includeDiff?: boolean | null;
      state?: "open" | "closed" | "merged" | "all" | null;
      author?: string | null;
      limit?: number | null;
      event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null;
    }, ctx: ToolContext) => {
      const token = ctx.secrets?.github_token;
      if (!token) return { error: "GitHub token not configured for this instance." };

      switch (params.action) {
        case "create":
          if (!params.title || !params.body || !params.head) return { error: "create requires title, body, and head." };
          return handleCreate(ctx, token, { repo: params.repo, title: params.title, body: params.body, head: params.head, base: params.base ?? null, draft: params.draft ?? null });

        case "get":
          if (params.number == null) return { error: "get requires number." };
          return handleGet(ctx, token, { repo: params.repo, number: params.number, includeDiff: params.includeDiff ?? null });

        case "comment":
          if (params.number == null || !params.body) return { error: "comment requires number and body." };
          return handleComment(ctx, token, { repo: params.repo, number: params.number, body: params.body });

        case "list":
          return handleList(ctx, token, { repo: params.repo, state: params.state ?? null, author: params.author ?? null, base: params.base ?? null, limit: params.limit ?? null });

        case "review":
          if (params.number == null || !params.event || !params.body) return { error: "review requires number, event, and body." };
          return handleReview(ctx, token, { repo: params.repo, number: params.number, event: params.event, body: params.body });
      }
  },
});
