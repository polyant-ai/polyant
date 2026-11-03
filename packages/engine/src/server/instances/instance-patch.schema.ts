// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { normalizeFieldMapping } from "../../conversations/field-mapping.js";
import { INTERMEDIATE_TEXT_POLICIES } from "../../ai-gateway/intermediate-text.js";
import { INSTANCE_STT_SETTINGS } from "../../stt-gateway/types.js";

const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A time zone or a locale is valid when Intl accepts it: the runtime formats dates with it on every turn. */
function intlAccepts(probe: (value: string) => void): (value: string) => boolean {
  return (value) => {
    try {
      probe(value);
      return true;
    } catch {
      return false;
    }
  };
}

const nonBlank = (what: string) =>
  z.string().refine((v) => v.trim() !== "", `must be a non-empty ${what}, or null to use the deployment default`);

/** Trimmed, deduplicated case-insensitively, and never empty: a list with no keyword would match nothing. */
const keywordList = z
  .array(z.string())
  .transform((keywords) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of keywords) {
      const trimmed = raw.trim();
      const lower = trimmed.toLowerCase();
      if (!trimmed || seen.has(lower)) continue;
      seen.add(lower);
      out.push(trimmed);
    }
    return out;
  })
  .refine((keywords) => keywords.length > 0, "must contain at least one non-empty keyword");

/**
 * The body of `PATCH /api/instances/:slug`: every key the route writes, with
 * its exact JSON type. A boolean is `true` or `false` and nothing else, so a
 * client that sends `"false"` gets a 400 naming the field instead of a yes. Enums
 * come from the constants the runtime reads, so what is accepted here is what
 * runs. A key not listed is dropped, as the store's whitelist always did.
 *
 * `null` on a nullable key is a decision (clear it back to the default);
 * omitting the key leaves the stored value alone.
 */
export const PatchInstanceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable(),
  status: z.string().min(1).max(20),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** Checked against the embedder registry by the controller: an embedder can be registered at boot. */
  embeddingProvider: z.string().min(1).max(20),
  /** Checked against what the embedder can emit by the controller. Changing it wipes data. */
  embeddingDim: z.number().int().positive(),
  memoryEnabled: z.boolean(),
  knowledgeEnabled: z.boolean(),
  langsmithEnabled: z.boolean(),
  langsmithProject: z.string().nullable(),
  authEnabled: z.boolean(),
  thinkingEnabled: z.boolean(),
  /** The full effort union: the gateway clamps it to the chosen model's levels at call time. */
  thinkingLevel: z.enum(REASONING_LEVELS),
  temperature: z.number().nullable(),
  fastMode: z.boolean(),
  stateInPromptEnabled: z.boolean(),
  datetimeInjectionEnabled: z.boolean(),
  datetimeTimezone: nonBlank("IANA time zone name")
    .refine(intlAccepts((tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz })), "is not a known IANA time zone")
    .nullable(),
  datetimeLocale: nonBlank("BCP 47 locale")
    .refine(intlAccepts((locale) => new Intl.DateTimeFormat(locale)), "is not a valid BCP 47 locale")
    .nullable(),
  dedupSimilarityThreshold: z.number().min(0).max(1).nullable(),
  // Zero is legitimate for all three: no debounce, no typing delay, no restart.
  messageSoftDebounceMs: z.number().int().min(0).nullable(),
  messageTypingDelayMs: z.number().int().min(0).nullable(),
  messageMaxRestarts: z.number().int().min(0).nullable(),
  cacheEnabled: z.boolean(),
  cacheTtl: z.string().min(1),
  intermediateText: z.enum(INTERMEDIATE_TEXT_POLICIES).nullable(),
  a2aEnabled: z.boolean(),
  toolResultsInHistoryEnabled: z.boolean(),
  debugEnabled: z.boolean(),
  attachmentStorageEnabled: z.boolean(),
  sttProvider: z.enum(INSTANCE_STT_SETTINGS),
  optoutEnabled: z.boolean(),
  optoutStopKeywords: keywordList,
  optoutResumeKeywords: keywordList,
  optoutClosingMessage: z.string().nullable(),
  optoutResumeMessage: z.string().nullable(),
  optoutInjectPromptHint: z.boolean(),
  webContextFieldMapping: z.unknown().transform((value, ctx) => {
    try {
      return normalizeFieldMapping(value, "webContextFieldMapping");
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  }),
  /**
   * Explicit acknowledgement that changing the embedding provider or dimension
   * permanently deletes this agent's memories and knowledge base. Required when
   * the switch would discard existing data.
   */
  confirmWipe: z.boolean(),
}).partial();

export type PatchInstanceBody = z.output<typeof PatchInstanceSchema>;
