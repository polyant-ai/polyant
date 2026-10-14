// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The credential decision, which is the security-sensitive half: an agent's
 * bucket is reached with the agent's own static keys and nothing else — never
 * the deployment's runtime identity, which every agent shares.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
    if (r.ok) expect(r.config.bucket).toBe("acme-files");
  });

  it("should_refuse_half_the_keys_even_with_the_retired_task_role_flag", () => {
    // Falling through would mask the missing half AND perform the write under
    // an identity nobody chose for this agent.
    const halves: Record<string, string>[] = [{ aws_access_key_id: "AKIA" }, { aws_secret_access_key: "shh" }];
    for (const half of halves) {
      const r = resolveAgentS3({ ...BUCKET, ...half, s3_use_task_role: "true" });

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("incomplete_credentials");
    }
  });

  it("should_refuse_without_static_keys", () => {
    const r = resolveAgentS3(BUCKET);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_configured");
  });

  /*
    The task-role mode is gone. An agent still carrying its opt-in must be told
    so by name: reading it as plain "not configured" hides why storage stopped,
    and honouring it would reach the deployment's shared runtime identity.
  */
  it("should_fail_by_name_for_an_agent_still_opted_in_to_the_task_role", () => {
    const r = resolveAgentS3({ ...BUCKET, s3_use_task_role: "true" });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("task_role_retired");
    expect(describeAgentS3Failure(r)).toMatch(/s3_use_task_role is no longer supported/);
  });

  it("should_use_static_keys_when_a_leftover_task_role_flag_sits_beside_them", () => {
    const r = resolveAgentS3({ ...BUCKET, ...STATIC, s3_use_task_role: "true" });

    expect(r.ok).toBe(true);
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

  it("should_bound_every_call_with_a_connection_and_a_request_timeout", async () => {
    // Without them an endpoint that accepted the connection and never answered
    // held an attachment upload, or a conversation's cleanup, indefinitely.
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      {
        const r = resolveAgentS3({ ...BUCKET, ...STATIC });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const handler = r.config.client.config.requestHandler as unknown as {
          handle(req: object): Promise<unknown>;
          httpHandlerConfigs(): Record<string, unknown>;
        };
        // The handler settles its options on its first request.
        await handler.handle({ protocol: "http:", hostname: "127.0.0.1", port, method: "GET", path: "/", headers: {}, query: {} });
        expect(handler.httpHandlerConfigs()).toMatchObject({
          connectionTimeout: 5_000,
          requestTimeout: 60_000,
          throwOnRequestTimeout: true,
        });
      }
    } finally {
      server.close();
    }
  });

  it("should_name_the_missing_thing_in_every_failure", () => {
    for (const reason of ["no_bucket", "incomplete_credentials", "task_role_retired", "not_configured"] as const) {
      expect(describeAgentS3Failure({ reason })).toMatch(/s3_bucket_name|aws_/);
    }
  });
});
