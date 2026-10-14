// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { importSecrets } from "./secrets.import.js";
import { decrypt } from "../crypto/index.js";

// importSecrets takes `tx` as a parameter, so a fake capturing the upserts is
// enough. Mirrors hooks.import.test.ts.
function makeFakeTx() {
  const written: Array<{ key: string; value: string }> = [];
  const tx = {
    insert: () => ({
      values: (v: { key: string; value: string }) => ({
        onConflictDoUpdate: () => {
          written.push(v);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { tx: tx as never, written };
}

const READABLE = new Set(["crm_base_url"]);

describe("importSecrets", () => {
  it("should_write_a_readable_parameter_encrypted_and_not_ask_for_it", async () => {
    const { tx, written } = makeFakeTx();

    const warnings = await importSecrets(
      tx,
      "inst-1",
      [{ key: "crm_base_url", configured: true, value: "https://crm.example.test" }],
      READABLE,
    );

    expect(warnings).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0].value).not.toBe("https://crm.example.test");
    expect(decrypt(written[0].value)).toBe("https://crm.example.test");
  });

  it("should_ask_for_a_credential_and_write_nothing", async () => {
    const { tx, written } = makeFakeTx();

    const warnings = await importSecrets(tx, "inst-1", [{ key: "crm_api_key", configured: true }], READABLE);

    expect(written).toEqual([]);
    expect(warnings).toEqual([{ type: "secret_required", message: 'Secret "crm_api_key" needs to be configured' }]);
  });

  it("SECURITY: should_ignore_a_value_the_bundle_puts_on_a_key_this_deployment_calls_sensitive", async () => {
    const { tx, written } = makeFakeTx();

    const warnings = await importSecrets(
      tx,
      "inst-1",
      [{ key: "crm_api_key", configured: true, value: "planted-by-the-bundle" }],
      READABLE,
    );

    expect(written).toEqual([]);
    expect(warnings.map((w) => w.type)).toEqual(["secret_required"]);
  });

  // A bundle exported before the S3 endpoint and task-role modes were removed
  // still names them. Asking for them sent the operator to set a key that now
  // does nothing, or, for the task role, one that makes storage refuse to run.
  it("drops the retired S3 keys, asking for the bucket's keys in place of the task role", async () => {
    const { tx, written } = makeFakeTx();

    const warnings = await importSecrets(
      tx,
      "inst-1",
      [
        { key: "s3_endpoint", configured: true, value: "https://minio.local" },
        { key: "s3_use_task_role", configured: true, value: "true" },
      ],
      new Set(["s3_endpoint", "s3_use_task_role"]),
    );

    expect(written).toEqual([]);
    expect(warnings).toEqual([
      {
        type: "secret_required",
        message:
          "s3_use_task_role is no longer supported and was not imported: set aws_access_key_id and aws_secret_access_key for the agent's bucket",
      },
    ]);
  });
});
