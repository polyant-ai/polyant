// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { writeFile, mkdir, stat } from "fs/promises";
import { dirname } from "path";
import { registerTool, type ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import {
  ensureWorkspaceDir,
  resolveWorkspacePath,
} from "./shared/workspace-utils.js";

registerTool({
  name: "writeFile",
  description:
    "Write a file to the sandboxed workspace of the current conversation.\n" +
    "Path is relative to the workspace (e.g. `notes.md`, `output/report.md`) — absolute paths and traversal (`../`) are not allowed.\n" +
    "Parent directories are created automatically if they do not exist.\n" +
    "By default overwrites an existing file: use `overwrite: false` to reject the write if the file already exists.\n" +
    "To read the file back, use `readFile` with the same relative path.",
  category: "workspace",
  inputExamples: [
    {
      label: "Write a text file to the workspace",
      input: {
        path: "notes.md",
        content: "# Notes\n\nSample text.",
        overwrite: true,
      },
    },
    {
      label: "Create a file in a subdirectory",
      input: {
        path: "output/report.md",
        content: "Generated report.",
        overwrite: true,
      },
    },
  ],
  create: (ctx: ToolContext) => ({
    parameters: z.object({
      path: z
        .string()
        .min(1)
        .describe(
          "Relative path of the file in the conversation workspace (e.g. `notes.md` or `output/report.md`). Absolute paths and `../` are not allowed.",
        ),
      content: z.string().describe("Text content to write (UTF-8)."),
      overwrite: z
        .boolean()
        .nullable()
        .describe(
          "If `false`, the tool returns an error when the file already exists. Default: `true` (overwrites).",
        ),
    }),
    execute: async ({
      path,
      content,
      overwrite,
    }: {
      path: string;
      content: string;
      overwrite: boolean | null;
    }) => {
      try {
        if (!ctx.conversationId) {
          return {
            error:
              "`writeFile` requires an active conversation (conversationId missing from context).",
          };
        }

        const resolvedPath = await resolveWorkspacePath(
          path,
          ctx.instanceId,
          ctx.conversationId,
        );

        // Check overwrite protection before doing any filesystem work
        const canOverwrite = overwrite !== false; // default: true
        if (!canOverwrite) {
          try {
            await stat(resolvedPath);
            // File exists and overwrite is disabled
            return {
              error: `File "${path}" already exists. Use \`overwrite: true\` to overwrite it.`,
            };
          } catch {
            // stat failed → file does not exist, we can proceed
          }
        }

        // Ensure workspace root exists and create any parent directories for nested paths
        await ensureWorkspaceDir(ctx.instanceId, ctx.conversationId);
        await mkdir(dirname(resolvedPath), { recursive: true });

        await writeFile(resolvedPath, content, "utf-8");

        const sizeBytes = Buffer.byteLength(content, "utf-8");

        ctx.audit.log({
          action: "workspace.writeFile",
          details: {
            path,
            resolvedPath,
            sizeBytes,
            overwrite: canOverwrite,
          },
          success: true,
        });

        return { path, sizeBytes, created: true };
      } catch (err) {
        const message = errMsg(err);
        ctx.audit.log({
          action: "workspace.writeFile",
          details: { path },
          success: false,
          error: message,
        });
        return { error: message };
      }
    },
  }),
});
