// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TranslationKey } from "@/lib/i18n/types";

/**
 * The secret keys the admin panel renders. The engine owns this vocabulary
 * (`instances/secrets.store.ts` `SECRET_KEYS`); this is the subset the web
 * surfaces, and it exists ONCE so no two credential surfaces can name the same
 * key differently.
 */
export const SECRET_KEYS = {
  OPENAI: "openai_api_key",
  ANTHROPIC: "anthropic_api_key",
  NEBIUS: "nebius_api_key",
  BEDROCK_API_KEY: "bedrock_api_key",
  // AWS credentials for the AI provider (Bedrock chat + embedder, Transcribe STT).
  // Dedicated namespace — independent of the generic aws_* keys used by tools.
  AWS_PROVIDER_ACCESS_KEY_ID: "aws_provider_access_key_id",
  AWS_PROVIDER_SECRET_ACCESS_KEY: "aws_provider_secret_access_key",
  AWS_PROVIDER_REGION: "aws_provider_region",
  LANGSMITH: "langsmith_api_key",
  AUTH: "auth_api_key",
  DEEPGRAM: "deepgram_api_key",
} as const;

export type ProviderSectionId = "openai" | "anthropic" | "nebius" | "aws" | "langsmith";

export interface ProviderSecretField {
  readonly key: string;
  readonly labelKey: TranslationKey;
  readonly placeholderKey?: TranslationKey;
  /** false = not a credential (the AWS region): rendered in cleartext, never masked. */
  readonly sensitive?: boolean;
}

export interface ProviderSecretSection {
  readonly id: ProviderSectionId;
  readonly titleKey: TranslationKey;
  readonly helpKey?: TranslationKey;
  readonly fields: readonly ProviderSecretField[];
}

/**
 * One section per provider — the grouping BOTH credential surfaces render, so
 * they read the same way by construction rather than by two lists agreeing.
 * The AWS triple used to sit in a flat queue between two unrelated keys with
 * nothing saying the three are one credential set.
 *
 * Provider credentials only. The inbound-auth key (`auth_api_key`) is
 * deliberately absent: it authenticates a CALLER to this agent rather than this
 * agent to a provider, and it belongs beside the channel that lets them in.
 */
export const PROVIDER_SECRET_SECTIONS: readonly ProviderSecretSection[] = [
  {
    id: "openai",
    titleKey: "settings.tab.provider.openai",
    fields: [{ key: SECRET_KEYS.OPENAI, labelKey: "settings.tab.openaiKey" }],
  },
  {
    id: "anthropic",
    titleKey: "settings.tab.provider.anthropic",
    fields: [{ key: SECRET_KEYS.ANTHROPIC, labelKey: "settings.tab.anthropicKey" }],
  },
  {
    id: "nebius",
    titleKey: "settings.tab.provider.nebius",
    fields: [{ key: SECRET_KEYS.NEBIUS, labelKey: "settings.tab.nebiusKey" }],
  },
  {
    id: "aws",
    titleKey: "settings.tab.awsCredentials",
    helpKey: "settings.tab.awsCredentialsHelp",
    fields: [
      { key: SECRET_KEYS.BEDROCK_API_KEY, labelKey: "settings.tab.bedrockApiKey" },
      {
        key: SECRET_KEYS.AWS_PROVIDER_ACCESS_KEY_ID,
        labelKey: "settings.tab.awsAccessKeyId",
        placeholderKey: "settings.tab.awsAccessKeyIdPlaceholder",
      },
      { key: SECRET_KEYS.AWS_PROVIDER_SECRET_ACCESS_KEY, labelKey: "settings.tab.awsSecretAccessKey" },
      {
        key: SECRET_KEYS.AWS_PROVIDER_REGION,
        labelKey: "settings.tab.awsRegion",
        placeholderKey: "settings.tab.awsRegionPlaceholder",
        sensitive: false,
      },
    ],
  },
  {
    id: "langsmith",
    titleKey: "settings.tab.provider.langsmith",
    fields: [{ key: SECRET_KEYS.LANGSMITH, labelKey: "settings.tab.langsmithApiKey" }],
  },
];

/**
 * Every key the credentials surfaces own — derived from the sections above so it
 * cannot drift from them, plus Deepgram, which is reached only through the
 * speech-to-text picker and so has no section of its own.
 *
 * Its use is subtractive: no OTHER surface may render one of these. A tool is
 * free to declare a provider key in its `requiredSecrets` (`claudeCode` asks for
 * `anthropic_api_key`) and reads the very key the agent already holds — so the
 * tools' secret page filters these out rather than offering a second field for
 * one credential, which is how "where do I put this key" came to have two
 * answers. `auth_api_key` is deliberately not here: it authenticates a caller
 * INTO this agent, belongs to no provider, and lives beside its channel.
 */
export const PROVIDER_CREDENTIAL_KEYS: ReadonlySet<string> = new Set<string>([
  ...PROVIDER_SECRET_SECTIONS.flatMap((section) => section.fields.map((field) => field.key)),
  SECRET_KEYS.DEEPGRAM,
]);
