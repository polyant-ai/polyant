// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import type { ToolContext } from "./registry.js";
import { ghExec, ghJson } from "./gh-exec.js";
import { errMsg } from "../../utils/error.js";

async function handleCreate(
  ctx: ToolContext,
  token: string,
  { repo, title, body, labels, assignee }: { repo: string; title: string; body: string; labels: string | null; assignee: string | null },
) {
  try {
    const args = ["issue", "create", "-R", repo, "--title", title, "--body", body];
    if (labels) args.push("--label", labels);
    if (assignee) args.push("--assignee", assignee);

    const result = await ghExec(args, token);
    if (result.exitCode !== 0) {
      ctx.audit.log({ action: "dev.ghCreateIssue", details: { repo, title }, success: false, error: result.stderr });
      return { error: result.stderr };
    }

    ctx.audit.log({ action: "dev.ghCreateIssue", details: { repo, title }, success: true });
    return { success: true, url: result.stdout.trim() };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghCreateIssue", details: { repo }, success: false, error: message });
    return { error: message };
  }
}

async function handleGet(
  ctx: ToolContext,
  token: string,
  { repo, number }: { repo: string; number: number },
) {
  try {
    const result = await ghJson(
      ["issue", "view", String(number), "-R", repo, "--json", "number,title,body,state,author,labels,comments,assignees,createdAt"],
      token,
    );
    if ("error" in result) {
      ctx.audit.log({ action: "dev.ghGetIssue", details: { repo, number }, success: false, error: result.error });
      return { error: result.error };
    }
    ctx.audit.log({ action: "dev.ghGetIssue", details: { repo, number }, success: true });
    return { issue: result.data };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghGetIssue", details: { repo, number }, success: false, error: message });
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
      ["issue", "comment", String(number), "-R", repo, "--body", body],
      token,
    );
    if (result.exitCode !== 0) {
      ctx.audit.log({ action: "dev.ghCommentIssue", details: { repo, number }, success: false, error: result.stderr });
      return { error: result.stderr };
    }

    ctx.audit.log({ action: "dev.ghCommentIssue", details: { repo, number }, success: true });
    return { success: true, url: result.stdout.trim() };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghCommentIssue", details: { repo, number }, success: false, error: message });
    return { error: message };
  }
}

async function handleSearch(
  ctx: ToolContext,
  token: string,
  { repo, query, state, labels, limit }: { repo: string; query: string | null; state: "open" | "closed" | "all" | null; labels: string | null; limit: number | null },
) {
  try {
    const effectiveLimit = limit ?? 100;
    const args = ["issue", "list", "-R", repo, "--json", "number,title,state,author,labels,createdAt,updatedAt", "--limit", String(effectiveLimit)];
    if (query) args.push("--search", query);
    args.push("--state", state ?? "all");
    if (labels) args.push("--label", labels);

    const result = await ghJson<unknown[]>(args, token);
    if ("error" in result) {
      ctx.audit.log({ action: "dev.ghSearchIssues", details: { repo }, success: false, error: result.error });
      return { error: result.error };
    }

    const count = result.data.length;
    ctx.audit.log({ action: "dev.ghSearchIssues", details: { repo, resultCount: count }, success: true });
    return {
      issues: result.data,
      count,
      ...(count === effectiveLimit ? { truncated: true, hint: `Returned exactly ${effectiveLimit} results — there may be more. Call again with a higher limit or narrower filters.` } : {}),
    };
  } catch (err) {
    const message = errMsg(err);
    ctx.audit.log({ action: "dev.ghSearchIssues", details: { repo }, success: false, error: message });
    return { error: message };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool registration                                                  */
/* ------------------------------------------------------------------ */

export default defineTool({
  name: "ghIssue",
  description:
    "Manage GitHub issues: create, read details, comment, or search.\n" +
    "Available actions:\n" +
    "- create: Create a new issue. Labels and assignee are optional. Labels must already exist in the repo.\n" +
    "- get: Retrieve full details of an issue (title, body, state, labels, assignees, comments). Requires the issue number.\n" +
    "- comment: Add a comment to an existing issue. Supports Markdown.\n" +
    "- search: Search issues with filters for state (open/closed/all), label, and text. Default limit 100, recommended max 500. Query searches title and body.\n" +
    "Do NOT use for pull requests — use `ghPR`.",
  category: "dev",
  requiredSecrets: ["github_token"],
  inputExamples: [
    {
      label: "Create issue with labels",
      input: { action: "create", repo: "owner/repo", title: "Bug: login fails on mobile", body: "Steps to reproduce...", labels: "bug,mobile" },
    },
    {
      label: "Issue details",
      input: { action: "get", repo: "owner/repo", number: 15 },
    },
    {
      label: "Search open issues with label bug",
      input: { action: "search", repo: "owner/repo", state: "open", labels: "bug", limit: 50 },
    },
  ],
  parameters: z.object({
      action: z.enum(["create", "get", "comment", "search"]).describe("Action to perform on the issue."),
      repo: z.string().describe("Repository in `owner/name` format."),
      number: z.number().nullable().describe("Issue number (required for `get` and `comment`)."),
      title: z.string().nullable().describe("Issue title (required for `create`)."),
      body: z.string().nullable().describe("Issue body or comment text (required for `create` and `comment`). Supports Markdown."),
      labels: z.string().nullable().describe("Comma-separated labels (optional for `create` and `search`)."),
      assignee: z.string().nullable().describe("Username to assign (only for `create`)."),
      query: z.string().nullable().describe("Text to search (only for `search`). Searches title and body."),
      state: z.enum(["open", "closed", "all"]).nullable().describe("Filter by state (only for `search`, default: all)."),
      limit: z.number().nullable().describe("Maximum number of results (only for `search`, default: 100, recommended max: 500)."),
    }),
  execute: async (params: {
      action: "create" | "get" | "comment" | "search";
      repo: string;
      number: number | null;
      title: string | null;
      body: string | null;
      labels: string | null;
      assignee: string | null;
      query: string | null;
      state: "open" | "closed" | "all" | null;
      limit: number | null;
    }, ctx: ToolContext) => {
      const token = ctx.secrets?.github_token;
      if (!token) return { error: "GitHub token not configured for this instance." };

      switch (params.action) {
        case "create":
          if (!params.title || !params.body) return { error: "create requires title and body." };
          return handleCreate(ctx, token, { repo: params.repo, title: params.title, body: params.body, labels: params.labels ?? null, assignee: params.assignee ?? null });

        case "get":
          if (params.number == null) return { error: "get requires number." };
          return handleGet(ctx, token, { repo: params.repo, number: params.number });

        case "comment":
          if (params.number == null || !params.body) return { error: "comment requires number and body." };
          return handleComment(ctx, token, { repo: params.repo, number: params.number, body: params.body });

        case "search":
          return handleSearch(ctx, token, { repo: params.repo, query: params.query ?? null, state: params.state ?? null, labels: params.labels ?? null, limit: params.limit ?? null });
      }
  },
});
