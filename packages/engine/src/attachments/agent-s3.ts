// SPDX-License-Identifier: AGPL-3.0-or-later

import { S3Client } from "@aws-sdk/client-s3";

/**
 * An agent's own object storage, resolved from its secrets — and the ONE place
 * that resolution happens.
 *
 * Object storage used to be the DEPLOYMENT's: `PLATFORM_S3_BUCKET` and its three
 * companions, one bucket for every tenant on the installation. Nobody ever set
 * them, so nothing was ever stored; and the tier was wrong anyway — a bucket is
 * something a tenant owns, alongside the credentials that reach it.
 *
 * The keys are `s3_bucket_name`, `aws_region`, `aws_access_key_id` and
 * `aws_secret_access_key`. The access is always the agent's own static keys:
 * the runtime identity of the deployment is never used for an agent's bucket.
 */
export interface AgentS3Config {
  readonly client: S3Client;
  readonly bucket: string;
}

/** Why an agent has no usable storage. Never thrown — the callers differ on what to do. */
export type AgentS3Failure =
  | { readonly reason: "not_configured" }
  | { readonly reason: "incomplete_credentials" }
  | { readonly reason: "task_role_retired" }
  | { readonly reason: "no_bucket" };

export type AgentS3Resolution = { readonly ok: true; readonly config: AgentS3Config } | ({ readonly ok: false } & AgentS3Failure);

const TRUTHY = ["true", "1", "yes"];

/**
 * Resolve the agent's credentials, refusing anything short of both static keys:
 *
 *  - both static keys → use them
 *  - exactly one → a configuration error naming the missing half
 *  - neither, with a leftover `s3_use_task_role` → its own error. That secret
 *    used to reach the deployment's runtime identity (the ECS task role) through
 *    the default provider chain. The mode is gone, and an agent that relied on
 *    it must learn so from the failure: quietly treating it as "not configured"
 *    would hide why its storage stopped working, and honouring it would let one
 *    agent act under an identity every agent on the deployment shares.
 *  - neither → refuse.
 */
export function resolveAgentS3(secrets: Record<string, string> | undefined): AgentS3Resolution {
  const bucket = secrets?.s3_bucket_name?.trim();
  const region = secrets?.aws_region?.trim();
  const accessKeyId = secrets?.aws_access_key_id?.trim();
  const secretAccessKey = secrets?.aws_secret_access_key?.trim();
  const retiredTaskRole = TRUTHY.includes((secrets?.s3_use_task_role ?? "").trim().toLowerCase());

  if (!bucket) return { ok: false, reason: "no_bucket" };
  if (!region) return { ok: false, reason: "not_configured" };

  // THERE IS NO CONFIGURABLE ENDPOINT. `s3_endpoint` used to be handed straight
  // to the SDK for MinIO and R2, which made an agent secret into a
  // server-side-request primitive: whoever can write an agent's secrets could
  // point every PUT and GET — with the file contents in them — at any host,
  // including one inside the deployment's private network. The rest of the
  // engine refuses that by construction (`utils/url-safety.ts`,
  // `utils/safe-http.ts`, the MCP transport); this was the one place that
  // bypassed it.
  //
  // Removed rather than validated, because no deployment was using it. An
  // origin check alone would not have been enough anyway — DNS rebinding
  // defeats a check made before the connection, which is why `pinnedLookup`
  // exists. Bringing S3-compatible storage back means an endpoint allow-list at
  // the DEPLOYMENT tier (not an agent secret) resolved through that pinning, not
  // this line.
  //
  // Every call is bounded. Without a timeout an S3 endpoint that accepts the
  // connection and never answers held the attachment upload, and with it the
  // turn's post-response work, or a conversation's cleanup, for as long as the
  // socket stayed open. The request bound covers sending the body too, so it
  // leaves room for the largest attachment on a slow link.
  const shared = {
    region,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000, throwOnRequestTimeout: true },
  };

  if (accessKeyId && secretAccessKey) {
    return {
      ok: true,
      config: {
        client: new S3Client({ ...shared, credentials: { accessKeyId, secretAccessKey } }),
        bucket,
      },
    };
  }
  if (accessKeyId || secretAccessKey) return { ok: false, reason: "incomplete_credentials" };
  if (retiredTaskRole) return { ok: false, reason: "task_role_retired" };
  return { ok: false, reason: "not_configured" };
}

/** One sentence per failure, for a log or an API answer. */
export function describeAgentS3Failure(failure: AgentS3Failure): string {
  switch (failure.reason) {
    case "no_bucket":
      return "no s3_bucket_name secret is set for this agent";
    case "incomplete_credentials":
      return "incomplete static S3 credentials: aws_access_key_id and aws_secret_access_key must both be set";
    case "task_role_retired":
      return "s3_use_task_role is no longer supported: set aws_access_key_id and aws_secret_access_key for the agent's bucket, then remove s3_use_task_role";
    case "not_configured":
      return "no S3 credentials: set aws_region, aws_access_key_id and aws_secret_access_key";
  }
}
