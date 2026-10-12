// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { errMsg } from "../../utils/error.js";
import {
  ensureWorkspaceDir,
  resolveWorkspacePath,
} from "./shared/workspace-utils.js";

export default defineTool({
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
  }, ctx) => {
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

        const canOverwrite = overwrite !== false; // default: true

        // Ensure workspace root exists and create any parent directories for nested paths
        await ensureWorkspaceDir(ctx.instanceId, ctx.conversationId);
        await mkdir(dirname(resolvedPath), { recursive: true });

        // Exclusive create ("wx") when overwriting is off: the existence check and
        // the write are one atomic operation, so a file created in between (or a
        // symlink planted at the path) is refused instead of overwritten.
        try {
          await writeFile(resolvedPath, content, {
            encoding: "utf-8",
            flag: canOverwrite ? "w" : "wx",
          });
        } catch (writeErr) {
          if ((writeErr as NodeJS.ErrnoException).code === "EEXIST") {
            return {
              error: `File "${path}" already exists. Use \`overwrite: true\` to overwrite it.`,
            };
          }
          throw writeErr;
        }

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
});
