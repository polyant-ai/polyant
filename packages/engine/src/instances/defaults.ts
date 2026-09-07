// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Section catalog for new instance seeding
// ---------------------------------------------------------------------------

/**
 * The seven prompt sections every instance is created with.
 *
 * Content is deliberately EMPTY. These used to carry default prose, which made
 * every new agent inherit an opinion nobody chose: six of the seven sections
 * typically stayed untouched, so an agent's actual behaviour came from text its
 * author had never read, and the same agent created against a different engine
 * version got different text. The rows still exist because the panel lists the
 * sections it gets from the API — without them there would be nowhere to write.
 *
 * The one exception is `05-skills`, which keeps `{{skillsList}}` and nothing
 * else. That placeholder is the only channel through which an instance's
 * assigned skills reach its prompt; dropping it would leave skills silently
 * inert on every new agent, with no error to explain why.
 */
export interface DefaultPrompt {
  sectionKey: string;
  title: string;
  content: string;
}

export const DEFAULT_PROMPTS: DefaultPrompt[] = [
  { sectionKey: "01-identity", title: "Identity", content: "" },
  { sectionKey: "02-soul", title: "Soul", content: "" },
  { sectionKey: "03-tooling", title: "Tooling", content: "" },
  { sectionKey: "04-safety", title: "Safety", content: "" },
  { sectionKey: "05-skills", title: "Skills", content: "{{skillsList}}" },
  { sectionKey: "06-memory", title: "Memory", content: "" },
  { sectionKey: "07-user-identity", title: "User Identity", content: "" },
];

/** Default enabled tool names — framework-level only, no domain-specific tools. */
export const DEFAULT_TOOL_NAMES: string[] = [
  "readSkill",
  "spawnTask",
];

/** Default skills for new instances. */
export const DEFAULT_SKILL_SLUGS: string[] = [];
