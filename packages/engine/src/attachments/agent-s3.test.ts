// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The credential decision, which is the security-sensitive half: the task role
 * is a SHARED identity, so reaching it must be a per-agent choice and never the
 * consequence of a half-filled form.
 */

import { describe, it, expect } from "vitest";
import { describeAgentS3Failure, resolveAgentS3 } from "./agent-s3.js";

/** The SDK stores a config value either as itself or as a provider function. */
async function resolved(value: unknown): Promise<unknown> {
  return typeof value === "function" ? await (value as () => unknown)() : value;
}

const BUCKET = { s3_bucket_name: "acme-files", aws_region: "eu-south-1" };
const STATIC = { aws_access_key_id: "AKIA", aws_secret_access_key: "shh" };

describe("resolveAgentS3", () => {
  it("should_use_static_keys_when_both_are_present", () => {
    const r = resolveAgentS3({ ...BUCKET, ...STATIC });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.credentialSource).toBe("static");
  });

  it("should_refuse_rather_than_fall_through_to_the_task_role_on_half_the_keys", () => {
    // The sharp one: falling through would mask the missing half AND perform the
    // write under an identity nobody chose for this agent.
    const halves: Record<string, string>[] = [{ aws_access_key_id: "AKIA" }, { aws_secret_access_key: "shh" }];
    for (const half of halves) {
      const r = resolveAgentS3({ ...BUCKET, ...half, s3_use_task_role: "true" });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("incomplete_credentials");
    }
  });

  it("should_reach_the_task_role_only_on_an_explicit_opt_in", () => {
    expect(resolveAgentS3(BUCKET).ok).toBe(false);

    const r = resolveAgentS3({ ...BUCKET, s3_use_task_role: "true" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.credentialSource).toBe("task-role");
  });

  it("should_refuse_without_a_bucket_even_with_perfect_credentials", () => {
    const r = resolveAgentS3({ aws_region: "eu-south-1", ...STATIC });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_bucket");
  });

  it("should_refuse_without_a_region", () => {
    // The SDK would throw at call time instead, far from the configuration.
    const r = resolveAgentS3({ s3_bucket_name: "acme-files", ...STATIC });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_configured");
  });

  /*
    An agent secret must not be able to choose where the client connects. It
    could, and that made every PUT and GET — with the file contents in them — a
    server-side request to any host the secret named, the deployment's private
    network included. The key is gone, and a leftover one from before the
    removal must be INERT rather than honoured.
  */
  it("should_ignore_a_leftover_s3_endpoint_and_stay_on_aws", async () => {
    const r = resolveAgentS3({ ...BUCKET, ...STATIC, s3_endpoint: "http://169.254.169.254" });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await resolved(r.config.client.config.forcePathStyle)).toBeFalsy();
    const endpoint = await resolved(r.config.client.config.endpoint);
    expect(JSON.stringify(endpoint ?? null)).not.toContain("169.254.169.254");
  });

  it("should_keep_virtual_host_addressing_for_real_aws", async () => {
    const r = resolveAgentS3({ ...BUCKET, ...STATIC });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await resolved(r.config.client.config.forcePathStyle)).toBeFalsy();
  });

  it("should_name_the_missing_thing_in_every_failure", () => {
    for (const reason of ["no_bucket", "incomplete_credentials", "not_configured"] as const) {
      expect(describeAgentS3Failure({ reason })).toMatch(/s3_bucket_name|aws_|s3_use_task_role/);
    }
  });
});
