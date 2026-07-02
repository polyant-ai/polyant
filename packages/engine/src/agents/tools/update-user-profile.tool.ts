// SPDX-License-Identifier: AGPL-3.0-or-later

import { createPromptUpdaterTool } from "./shared/update-prompt-section.js";

export default createPromptUpdaterTool({
  toolName: "updateUserProfile",
  description:
    "Update the user profile with personal information: personal data, professional details, preferences, interests, goals, habits.\n" +
    "Use when the user shares stable information about themselves that must persist across conversations.\n" +
    "Do NOT use to modify the assistant's personality — use updateSoul.\n" +
    "Do NOT use to save facts unrelated to the user profile — use saveMemory.\n" +
    "Returns an update confirmation. The change is permanent (updates the user profile section).\n" +
    "Caveat: pass a clear, concise instruction. Previous information is not deleted — only integrated or updated if contradicted.",
  sectionId: "07-user-identity",
  displayName: "User Identity",
  defaultContent: "# User\n\nNo information available about the user.\n",
  paramDescription:
    "Instruction on what to update in the user profile (e.g. 'the user is 32 years old', 'the user is allergic to peanuts', 'the user follows a vegan diet', 'the user plays tennis')",
  auditAction: "prompt.updateProfile",
  buildSystemPrompt: () =>
    "You are a markdown file editor. " +
    "You are given the current content of a file describing a user's profile, " +
    "and an instruction with new information to integrate. " +
    "Reply ONLY with the complete new file content, no explanations, no code blocks. " +
    "The file must start with '# User' and use a list format with '- **Field**: value'. " +
    "Integrate the new information while preserving everything not explicitly changed or contradicted.",
  buildUserPrompt: (instruction, current) =>
    `## Current file content:\n\n${current}\n\n` +
    `## Update instruction:\n\n${instruction}`,
});
