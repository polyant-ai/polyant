// SPDX-License-Identifier: AGPL-3.0-or-later

import { S3Client } from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

/**
 * An agent's own object storage, resolved from its secrets — and the ONE place
 * that resolution happens.
 *
 * Object storage used to be the DEPLOYMENT's: `PLATFORM_S3_BUCKET` and its three
 * companions, one bucket for every tenant on the installation. Nobody ever set
 * them, so nothing was ever stored; and the tier was wrong anyway — a bucket is
 * something a tenant owns, alongside the credentials that reach it.
 *
 * The keys are the ones the `fileUpload` tool already declares, deliberately:
 * an agent has ONE bucket, used by the tool and by attachment persistence, so
 * there is no second namespace to document and no way for the two to disagree
 * about where an agent's files live.
 */
export interface AgentS3Config {
  readonly client: S3Client;
  readonly bucket: string;
  /** How the credentials were obtained, for the log line that says so. */
  readonly credentialSource: "static" | "task-role";
}

/** Why an agent has no usable storage. Never thrown — the callers differ on what to do. */
export type AgentS3Failure =
  | { readonly reason: "not_configured" }
  | { readonly reason: "incomplete_credentials" }
  | { readonly reason: "no_bucket" };

export type AgentS3Resolution = { readonly ok: true; readonly config: AgentS3Config } | ({ readonly ok: false } & AgentS3Failure);

const TRUTHY = ["true", "1", "yes"];

/**
 * Resolve the credential mode EXPLICITLY, because the failure modes are not
 * symmetric:
 *
 *  - both static keys → use them
 *  - exactly one → a configuration ERROR, never a silent fall-through to the
 *    task role, which would mask the missing half
 *  - neither, with `s3_use_task_role` → the default provider chain (the ECS task
 *    role), for a bucket whose policy trusts that role
 *  - neither, without the opt-in → refuse. The task role is a SHARED identity:
 *    using it has to be a per-agent decision, or one agent's write lands under
 *    an identity nobody chose for it.
 */
export function resolveAgentS3(secrets: Record<string, string> | undefined): AgentS3Resolution {
  const bucket = secrets?.s3_bucket_name?.trim();
  const region = secrets?.aws_region?.trim();
  const accessKeyId = secrets?.aws_access_key_id?.trim();
  const secretAccessKey = secrets?.aws_secret_access_key?.trim();
  const endpoint = secrets?.s3_endpoint?.trim();
  const taskRole = TRUTHY.includes((secrets?.s3_use_task_role ?? "").trim().toLowerCase());

  if (!bucket) return { ok: false, reason: "no_bucket" };
  if (!region) return { ok: false, reason: "not_configured" };

  // `forcePathStyle` with an explicit endpoint: MinIO and most S3-compatible
  // servers do not resolve bucket-as-subdomain, so virtual-host addressing —
  // the SDK's default — reaches a host that does not exist.
  const shared = endpoint ? { region, endpoint, forcePathStyle: true } : { region };

  if (accessKeyId && secretAccessKey) {
    return {
      ok: true,
      config: {
        client: new S3Client({ ...shared, credentials: { accessKeyId, secretAccessKey } }),
        bucket,
        credentialSource: "static",
      },
    };
  }
  if (accessKeyId || secretAccessKey) return { ok: false, reason: "incomplete_credentials" };
  if (taskRole) {
    return {
      ok: true,
      config: {
        client: new S3Client({ ...shared, credentials: fromNodeProviderChain() }),
        bucket,
        credentialSource: "task-role",
      },
    };
  }
  return { ok: false, reason: "not_configured" };
}

/** One sentence per failure, for a log or an API answer. */
export function describeAgentS3Failure(failure: AgentS3Failure): string {
  switch (failure.reason) {
    case "no_bucket":
      return "no s3_bucket_name secret is set for this agent";
    case "incomplete_credentials":
      return "incomplete static S3 credentials: aws_access_key_id and aws_secret_access_key must both be set";
    case "not_configured":
      return "no S3 credentials: set aws_access_key_id + aws_secret_access_key and aws_region, or opt in to the task role with s3_use_task_role";
  }
}
