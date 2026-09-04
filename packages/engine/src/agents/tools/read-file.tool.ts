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
    "• ABSOLUTE — must still reside inside the conversation workspace (typically the path returned by `gitCloneRepo`).\n" +
    "Returns the file text (truncated to 500 lines or 512 KB).\n" +
    "Supports the `tail` option to read only the last N lines (useful for log files).\n" +
    "To explore the structure, use `listDirectory` first.",
  category: "dev",
  inputExamples: [
    {
      label: "Read a file written to the workspace",
      input: {
        path: "notes.md",
        tail: null,
      },
    },
    {
      label: "Read a file from a cloned repository (relative path)",
      input: {
        path: ".repos/owner/repo-abc123/_hot.md",
        tail: null,
      },
    },
    {
      label: "Last 30 lines of a log",
      input: {
        path: ".repos/owner/repo-abc123/_log.md",
        tail: 30,
      },
    },
  ],
  parameters: z.object({
    path: z.string().describe(
      "File path. Relative (recommended) or absolute — in both cases must resolve inside the current conversation's sandboxed workspace.",
    ),
    tail: z.number().int().min(1).nullable()
      .describe("If specified, returns only the last N lines of the file. Useful for log files."),
  }),
  execute: async ({ path, tail }: { path: string; tail: number | null }, ctx) => {
    let resolvedPath: string;
    let source: "workspace-relative" | "workspace-absolute";

    try {
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
          return { error: `File too large: ${(fileStat.size / 1024).toFixed(0)} KB (max 512 KB). Try tail to read only the end of the file.` };
        }
        content = await handle.readFile("utf-8");
      } finally {
        await handle.close();
      }

      let result: string;
      if (tail != null) {
        const lines = content.split("\n");
        const tailLines = lines.slice(-tail);
        result = tailLines.join("\n");
      } else {
        const lines = content.split("\n");
        if (lines.length > MAX_LINES) {
          result = lines.slice(0, MAX_LINES).join("\n") + `\n\n[... truncated: ${lines.length} total lines, showing first ${MAX_LINES}]`;
        } else {
          result = content;
        }
      }

      ctx.audit.log({
        action: "workspace.readFile",
        details: { path: resolvedPath, source, sizeBytes: fileStat.size, tail: tail ?? null },
        success: true,
      });

      return { content: result, sizeBytes: fileStat.size, lines: content.split("\n").length };
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
