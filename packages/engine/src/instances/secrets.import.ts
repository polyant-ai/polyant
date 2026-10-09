// SPDX-License-Identifier: AGPL-3.0-or-later

import { instanceSecrets } from "./secrets.schema.js";
import { encrypt } from "../crypto/index.js";
import { readableSecretKeys } from "./readable-secret-keys.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { ImportWarning, TxClient } from "./import.types.js";

/**
 * Write the readable parameters a bundle carries; ask for everything else.
 *
 * The bundle is untrusted input, so its own `value` does not decide whether a
 * key is readable: THIS deployment's tools and hooks do, exactly as they decided
 * it on export. A bundle that puts a value on a key declared sensitive here is
 * treated as if it carried none, and the key is asked for like any credential.
 * A key already set on an overwrite target is replaced only by a readable value.
 */
export async function importSecrets(
  tx: TxClient,
  instanceId: string,
  secrets: ExportInstanceData["secrets"],
  readable: ReadonlySet<string> = readableSecretKeys(),
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const secret of secrets) {
    // Keys of removed storage modes, still named by older bundles (see
    // `attachments/agent-s3.ts`). An endpoint does nothing now; a task-role
    // flag would make storage refuse to run, so the bucket's keys are asked for.
    if (secret.key === "s3_endpoint") continue;
    if (secret.key === "s3_use_task_role") {
      warnings.push({
        type: "secret_required",
        message:
          "s3_use_task_role is no longer supported and was not imported: set aws_access_key_id and aws_secret_access_key for the agent's bucket",
      });
      continue;
    }

    if (secret.value === undefined || !readable.has(secret.key)) {
      warnings.push({
        type: "secret_required",
        message: `Secret "${secret.key}" needs to be configured`,
      });
      continue;
    }

    const value = encrypt(secret.value);
    await tx
      .insert(instanceSecrets)
      .values({ instanceId, key: secret.key, value })
      .onConflictDoUpdate({
        target: [instanceSecrets.instanceId, instanceSecrets.key],
        set: { value, updatedAt: new Date() },
      });
  }

  return warnings;
}
