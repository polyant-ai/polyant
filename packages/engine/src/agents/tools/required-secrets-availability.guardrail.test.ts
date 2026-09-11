// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Guard-rail: a tool must be REACHABLE by an agent that configured it.
 *
 * `missingRequiredSecrets` decides whether the supervisor offers a tool to the
 * model at all, and a tool it hides produces no error anywhere — it is simply
 * never called. The failure is therefore invisible from the outside: the agent
 * behaves as if the tool did not exist, which is indistinguishable from the
 * model choosing not to use it.
 *
 * That is how `fileUpload` came to be hidden from EVERY agent (oss#350): its
 * `requiredSecrets` listed the two alternative credential shapes as bare
 * strings, and a bare string normalizes to a MANDATORY spec. No agent can hold
 * both static keys and the task-role opt-in at once, so the mandatory set was
 * unsatisfiable and the tool disappeared.
 *
 * Two checks, and they cover different things. The sweep over the registry
 * exercises the gate itself and would catch it being read the wrong way round;
 * it does NOT catch an unsatisfiable mandatory set, because "the keys a tool
 * declares mandatory" is exactly what it sets. Only naming the credential
 * shapes catches that, and a shape is not derivable from the declaration — it
 * is the contract of whatever resolver the tool delegates to.
 */

import { describe, expect, it, beforeAll } from "vitest";
import {
  loadAllTools,
  getToolRegistry,
  missingRequiredSecrets,
  normalizeRequiredSecrets,
} from "./registry.js";

describe("requiredSecrets gate availability", () => {
  beforeAll(async () => {
    await loadAllTools();
  });

  /**
   * The gate itself, exercised over every registered tool: setting exactly the
   * keys a tool declares MANDATORY must make it available. This is what breaks
   * if the optional flag is ever read the wrong way round — an inverted filter
   * passes every unit test of `normalizeRequiredSecrets` and hides every tool
   * that declares an optional key.
   */
  it("offers every tool once its mandatory keys are set", () => {
    let checked = 0;
    const hidden: string[] = [];

    for (const [name, def] of getToolRegistry()) {
      if (!def.requiredSecrets?.length) continue;
      checked += 1;
      const mandatory = normalizeRequiredSecrets(def.requiredSecrets).filter((s) => !s.optional);
      const secrets = Object.fromEntries(mandatory.map((s) => [s.key, "set"]));
      if (missingRequiredSecrets(def.requiredSecrets, secrets).length > 0) hidden.push(name);
    }

    expect(checked, "no tool declares requiredSecrets — registry empty?").toBeGreaterThan(5);
    expect(hidden).toEqual([]);
  });

  /**
   * `fileUpload` is the tool whose credentials come in two shapes, so it is the
   * one where a mandatory declaration of an alternative bites. Both shapes are
   * spelled out here because they are the contract `attachments/agent-s3.ts`
   * resolves, and an agent holds one of them, never both.
   */
  describe("fileUpload is reachable under each credential shape", () => {
    const shapes = {
      "static keys": {
        s3_bucket_name: "bucket",
        aws_region: "eu-west-1",
        aws_access_key_id: "key-id",
        aws_secret_access_key: "secret",
      },
      "task role": {
        s3_bucket_name: "bucket",
        aws_region: "eu-west-1",
        s3_use_task_role: "true",
      },
    };

    for (const [shape, secrets] of Object.entries(shapes)) {
      it(`is offered with ${shape}`, () => {
        const def = getToolRegistry().get("fileUpload");
        expect(def, "fileUpload is not registered").toBeDefined();
        expect(missingRequiredSecrets(def!.requiredSecrets, secrets)).toEqual([]);
      });
    }

    it("is withheld from an agent with no bucket", () => {
      const def = getToolRegistry().get("fileUpload");
      expect(missingRequiredSecrets(def!.requiredSecrets, { aws_region: "eu-west-1" })).toEqual([
        "s3_bucket_name",
      ]);
    });
  });
});
