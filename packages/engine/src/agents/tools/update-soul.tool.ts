// SPDX-License-Identifier: AGPL-3.0-or-later

import { createPromptUpdaterTool } from "./shared/update-prompt-section.js";

export default createPromptUpdaterTool({
  toolName: "updateSoul",
  description:
    "Modify the assistant's personality (name, tone, style, behavior, values).\n" +
    "Use when the user asks to change the assistant's name, tone, signature, communication style, or personality traits.\n" +
    "Do NOT use to update information about the user — use updateUserProfile.\n" +
    "Returns an update confirmation. The change is permanent (overwrites the personality section).\n" +
    "Caveat: uses an LLM to integrate changes into the existing prompt. Pass clear and specific instructions.",
  sectionId: "02-soul",
  displayName: "Soul",
  defaultContent: "# Personality\n",
  paramDescription:
    "Instruction on how to update the personality (e.g. 'call yourself Exy and sign with ⚙️', 'be more formal')",
  auditAction: "prompt.updateSoul",
  buildSystemPrompt: () =>
    "You are a markdown file editor. " +
    "You are given the current content of a file describing an AI assistant's personality, " +
    "and an instruction on how to modify it. " +
    "Reply ONLY with the complete new file content, no explanations, no code blocks. " +
    "Maintain the markdown structure with ## headings. " +
    "Integrate the requested changes while preserving everything not explicitly changed.",
  buildUserPrompt: (instruction, current) =>
    `## Current file content:\n\n${current}\n\n` +
    `## Modification instruction:\n\n${instruction}`,
});
