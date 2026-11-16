// SPDX-License-Identifier: AGPL-3.0-or-later

import { getPrompts, getPromptSection, invalidatePromptsCache, upsertPrompt } from "./prompts.store.js";
import type { InstanceUuid } from "./identifiers.js";

/** The sections an agent's system prompt is made of, in prompt order. */
export const PROMPT_SECTION_KEYS = [
  "01-identity",
  "02-soul",
  "03-tooling",
  "04-safety",
  "05-skills",
  "06-memory",
  "07-user-identity",
] as const;

export type PromptSectionKey = (typeof PROMPT_SECTION_KEYS)[number];

/** The longest content one section may hold. */
export const PROMPT_SECTION_MAX_CHARS = 32_768;

export interface PromptSectionView {
  key: string;
  filename: string;
  title: string;
  content: string;
}

/** An agent's prompt sections as the panel shows them. */
export async function readAgentPrompt(instanceId: InstanceUuid): Promise<PromptSectionView[]> {
  const rows = await getPrompts(instanceId);
  return rows.map((r) => ({ key: r.sectionKey, filename: `${r.sectionKey}.md`, title: r.title, content: r.content }));
}

/** Replace the content of the given sections, keeping each one's title; returns the whole prompt. */
export async function writeAgentPrompt(
  instanceId: InstanceUuid,
  sections: readonly { key: PromptSectionKey; content: string }[],
): Promise<PromptSectionView[]> {
  for (const section of sections) {
    const existing = await getPromptSection(instanceId, section.key);
    const title = existing?.title ?? section.key;
    await upsertPrompt(instanceId, section.key, title, section.content);
  }
  invalidatePromptsCache(instanceId);
  return readAgentPrompt(instanceId);
}
