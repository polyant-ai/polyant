// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { readdir, stat } from "fs/promises";
import { resolve, join } from "path";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../../utils/error.js";
import {
  isRelativePath,
  resolveWorkspacePath,
  assertInsideConversationWorkspace,
} from "./shared/workspace-utils.js";

const MAX_ENTRIES = 200;

export default defineTool({
  name: "listDirectory",
  description:
    "List the contents of a directory from the current conversation's sandboxed workspace.\n" +
    "Supports two path formats, both resolved inside the same sandbox:\n" +
    "• RELATIVE (e.g. `.`, `.repos/owner/repo-abc123`) — more concise, recommended.\n" +
    "• ABSOLUTE — must still reside inside the conversation workspace (typically the path returned by `gitCloneRepo`).\n" +
    "Returns the list of files and subdirectories with type and size.\n" +
    "To read the content of a file, use `readFile`.",
  category: "dev",
  inputExamples: [
    {
      label: "List conversation workspace root",
      input: {
        path: ".",
      },
    },
    {
      label: "List cloned repo root (relative path)",
      input: {
        path: ".repos/owner/repo-abc123",
      },
    },
    {
      label: "List subdirectory of a cloned repo",
      input: {
        path: ".repos/owner/repo-abc123/50-Log",
      },
    },
  ],
  parameters: z.object({
    path: z.string().describe(
      "Directory path. Relative (recommended) or absolute — must resolve inside the current conversation's sandboxed workspace.",
    ),
  }),
  execute: async ({ path }: { path: string }, ctx) => {
      let resolvedPath: string;
      let source: "workspace-relative" | "workspace-absolute";

      try {
        if (!ctx.conversationId) {
          return {
            error:
              "listDirectory requires an active conversation (conversationId missing from context).",
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

        const dirStat = await stat(resolvedPath);
        if (!dirStat.isDirectory()) {
          return { error: `Path is not a directory: ${path}. Use readFile to read files.` };
        }

        const entries = await readdir(resolvedPath, { withFileTypes: true });

        // Sort: directories first, then files, alphabetically
        const sorted = entries
          .filter((e) => !e.name.startsWith(".")) // skip hidden files (.git, etc.)
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, MAX_ENTRIES);

        const items = await Promise.all(
          sorted.map(async (entry) => {
            const fullPath = join(resolvedPath, entry.name);
            if (entry.isDirectory()) {
              return { name: entry.name, type: "directory" as const };
            }
            try {
              const fileStat = await stat(fullPath);
              return { name: entry.name, type: "file" as const, sizeBytes: fileStat.size };
            } catch {
              return { name: entry.name, type: "file" as const };
            }
          }),
        );

        const truncated = entries.length > MAX_ENTRIES;

        ctx.audit.log({
          action: "workspace.listDirectory",
          details: { path: resolvedPath, source, entryCount: items.length },
          success: true,
        });

        return { path: resolvedPath, entries: items, totalEntries: entries.length, truncated };
      } catch (err) {
        const message = errMsg(err);
        ctx.audit.log({
          action: "workspace.listDirectory",
          details: { path },
          success: false,
          error: message,
        });
        return { error: message };
      }
  },
});
