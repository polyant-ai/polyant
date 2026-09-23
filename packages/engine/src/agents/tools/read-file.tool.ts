// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { open } from "fs/promises";
import { constants } from "fs";
import { resolve } from "path";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../../utils/error.js";
import {
  isRelativePath,
  resolveWorkspacePath,
  assertInsideConversationWorkspace,
} from "./shared/workspace-utils.js";

const MAX_FILE_SIZE = 512 * 1024; // 512 KB
const MAX_LINES = 500;

export default defineTool({
  name: "readFile",
  description:
    "Read the content of a file from the current conversation's sandboxed workspace.\n" +
    "Supports two path formats, both resolved inside the same sandbox:\n" +
    "• RELATIVE (e.g. `notes.md`, `.repos/owner/repo/README.md`) — more concise, recommended.\n" +
    "• ABSOLUTE — must still reside inside the conversation workspace.\n" +
    "Returns the file text (truncated to 500 lines or 512 KB).\n" +
    "Reading without a range returns the WHOLE file, which stays in the conversation for the rest of the turn — " +
    "use `offset`/`limit` to read a window around what you need, or `tail` for the last N lines of a log.\n" +
    "The result reports the file's total line count, so a window can be paged deliberately.\n" +
    "To explore the structure, use `listDirectory` first.",
  category: "dev",
  inputExamples: [
    {
      label: "Read a file written to the workspace",
      input: {
        path: "notes.md",
        tail: null,
        offset: null,
        limit: null,
      },
    },
    {
      label: "Read a file from a cloned repository (relative path)",
      input: {
        path: ".repos/owner/repo-abc123/_hot.md",
        tail: null,
        offset: null,
        limit: null,
      },
    },
    {
      label: "Last 30 lines of a log",
      input: {
        path: ".repos/owner/repo-abc123/_log.md",
        tail: 30,
        offset: null,
        limit: null,
      },
    },
    {
      label: "80 lines around a match found at line 214",
      input: {
        path: ".repos/owner/repo-abc123/spec.md",
        tail: null,
        offset: 180,
        limit: 80,
      },
    },
  ],
  parameters: z.object({
    path: z.string().describe(
      "File path. Relative (recommended) or absolute — in both cases must resolve inside the current conversation's sandboxed workspace.",
    ),
    tail: z.number().int().min(1).nullable()
      .describe("If specified, returns only the last N lines of the file. Useful for log files."),
    offset: z.number().int().min(1).nullable()
      .describe("1-indexed first line to return. Pass null to start at the beginning."),
    limit: z.number().int().min(1).nullable()
      .describe("How many lines to return from `offset` (capped at 500). Pass null for the default cap."),
  }),
  execute: async (
    { path, tail, offset, limit }: { path: string; tail: number | null; offset: number | null; limit: number | null },
    ctx,
  ) => {
    let resolvedPath: string;
    let source: "workspace-relative" | "workspace-absolute";

    try {
      if (tail != null && (offset != null || limit != null)) {
        return { error: "readFile takes either tail or offset/limit, not both." };
      }

      if (!ctx.conversationId) {
        return {
          error:
            "readFile requires an active conversation (conversationId missing from context).",
        };
      }

      if (isRelativePath(path)) {
        resolvedPath = await resolveWorkspacePath(path, ctx.instanceId, ctx.conversationId);
        source = "workspace-relative";
      } else {
        resolvedPath = resolve(path);
        await assertInsideConversationWorkspace(resolvedPath, ctx.instanceId, ctx.conversationId);
        source = "workspace-absolute";
      }

      // Stat and read through ONE file handle so the checks below apply to the very
      // bytes we return. Re-resolving the path for the read would let it point at a
      // different file than the one that passed the type/size gates (TOCTOU).
      //
      // O_NONBLOCK keeps that property while making the open itself un-blockable:
      // opening a FIFO for reading blocks until a writer appears, and since the type
      // gate can only run AFTER the open, a FIFO inside the workspace would otherwise
      // hang the tool call. With O_NONBLOCK the open returns immediately and
      // `isFile()` below rejects it. Regular files ignore the flag, so the normal
      // read path is unchanged (no lstat-then-open race is reintroduced).
      const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK);
      let fileStat: Awaited<ReturnType<typeof handle.stat>>;
      let content: string;
      try {
        fileStat = await handle.stat();
        if (!fileStat.isFile()) {
          return { error: `Path is not a file: ${path}. Use listDirectory to explore directories.` };
        }
        if (fileStat.size > MAX_FILE_SIZE) {
          return { error: `File too large: ${(fileStat.size / 1024).toFixed(0)} KB (max 512 KB). Read a window of it with offset/limit, or its end with tail.` };
        }
        content = await handle.readFile("utf-8");
      } finally {
        await handle.close();
      }

      const lines = content.split("\n");
      const totalLines = lines.length;

      let result: string;
      if (tail != null) {
        result = lines.slice(-tail).join("\n");
      } else if (offset != null || limit != null) {
        // A window the caller asked for. The MAX_LINES cap still applies, so a
        // huge `limit` cannot undo the point of asking for a range.
        const start = (offset ?? 1) - 1;
        const count = Math.min(limit ?? MAX_LINES, MAX_LINES);
        const window = lines.slice(start, start + count);
        const last = start + window.length;
        result = start >= totalLines
          ? `[no lines: offset ${start + 1} is past the end of the file, which has ${totalLines} lines]`
          : window.join("\n") + `\n\n[lines ${start + 1}-${last} of ${totalLines}]`;
      } else if (totalLines > MAX_LINES) {
        result = lines.slice(0, MAX_LINES).join("\n") + `\n\n[... truncated: ${totalLines} total lines, showing first ${MAX_LINES}]`;
      } else {
        result = content;
      }

      ctx.audit.log({
        action: "workspace.readFile",
        details: { path: resolvedPath, source, sizeBytes: fileStat.size, tail: tail ?? null, offset: offset ?? null, limit: limit ?? null },
        success: true,
      });

      return { content: result, sizeBytes: fileStat.size, lines: totalLines };
    } catch (err) {
      const message = errMsg(err);
      ctx.audit.log({
        action: "workspace.readFile",
        details: { path },
        success: false,
        error: message,
      });
      return { error: message };
    }
  },
});
