// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Environment variables the engine no longer reads, and where each value lives
 * now. They are not failed on: a deployment upgraded without removing one keeps
 * booting. But the value has no effect, and an operator who does not know that
 * believes the old setting still holds — so the engine says so at boot, once
 * per variable, naming where to set it instead.
 */
const PER_AGENT_BUCKET =
  "each agent's fileUpload tool (s3_bucket_name, aws_region and its credentials); files already in the platform bucket are copied as docs/UPGRADING.md shows";

export const RETIRED_ENVIRONMENT_VARIABLES: ReadonlyMap<string, string> = new Map([
  ["AGENT_CALL_TIMEOUT_MS", "Settings → General"],
  ["ANALYTICS_RETENTION_DAYS", "Settings → General"],
  ["DATETIME_LOCALE", "the agent's Settings → Behaviour"],
  ["DATETIME_TIMEZONE", "the agent's Settings → Behaviour (a deployment-wide zone is TZ)"],
  ["DEDUP_SIMILARITY_THRESHOLD", "the agent's Settings → Behaviour"],
  ["KNOWLEDGE_MAX_DOCS_PER_INSTANCE", "the organization's knowledge-document entitlement"],
  ["MCP_CONNECT_TIMEOUT_MS", "Settings → General"],
  ["MESSAGE_MAX_RESTARTS", "the agent's Settings → Behaviour"],
  ["MESSAGE_SOFT_DEBOUNCE_MS", "the agent's Settings → Behaviour"],
  ["MESSAGE_TYPING_DELAY_MS", "the agent's Settings → Behaviour"],
  ["PDF_CONCURRENCY", "the Markdown-to-PDF plugin's own configuration"],
  // The deployment-wide bucket is gone: attachments and fileUpload use each
  // agent's own bucket, configured on its fileUpload tool.
  ["PLATFORM_S3_ACCESS_KEY_ID", PER_AGENT_BUCKET],
  ["PLATFORM_S3_BUCKET", PER_AGENT_BUCKET],
  ["PLATFORM_S3_REGION", PER_AGENT_BUCKET],
  ["PLATFORM_S3_SECRET_ACCESS_KEY", PER_AGENT_BUCKET],
  ["SCHEDULER_DEFAULT_MAX_RUN_MS", "Settings → General"],
  ["SCHEDULER_ORPHAN_GRACE_MS", "Settings → General"],
  ["SSE_MAX_CONNECTIONS", "Settings → General"],
  ["SSE_MAX_CONNECTIONS_PER_USER", "Settings → General"],
  ["THROTTLE_LIMIT", "Settings → General"],
  ["THROTTLE_TTL_MS", "Settings → General"],
]);

/** One warning per retired variable still set in `env`. */
export function retiredEnvironmentWarnings(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [...RETIRED_ENVIRONMENT_VARIABLES]
    .filter(([name]) => env[name] !== undefined && env[name] !== "")
    .map(([name, where]) => `[config] ${name} is set but no longer read: set the value in ${where}, then remove the variable`);
}
