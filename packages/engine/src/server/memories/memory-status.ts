// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Instance } from "../../instances/store.js";
import { findInstanceByIdOrSlug } from "../../instances/resolve-instance-id.js";
import { getAllSecretsById, SECRET_KEYS } from "../../instances/secrets.store.js";

/**
 * Embedding-pipeline readiness for an instance's memory feature.
 * - `needsOpenAIKey`: memory is ON but the configured embedding path is unusable.
 * - `canEnable`: the embedding pipeline is ready.
 * Memory OFF always reports both false (no banner).
 */
export interface MemoryStatus {
  readonly needsOpenAIKey: boolean;
  readonly canEnable: boolean;
}

const OFF: MemoryStatus = { needsOpenAIKey: false, canEnable: false };

/** Core logic given a loaded Instance (avoids a second DB round trip). */
export async function computeMemoryStatusFromInstance(instance: Instance): Promise<MemoryStatus> {
  if (!instance.memoryEnabled) return OFF;
  const secrets = await getAllSecretsById(instance.id);
  const provider = instance.provider ?? "openai";
  if (provider === "bedrock") {
    const hasRegion = !!secrets[SECRET_KEYS.AWS_REGION];
    return { needsOpenAIKey: !hasRegion, canEnable: hasRegion };
  }
  const hasOpenAIKey = !!secrets[SECRET_KEYS.OPENAI_API_KEY];
  return { needsOpenAIKey: !hasOpenAIKey, canEnable: hasOpenAIKey };
}

/** Derive memory embedding status by instance id or slug. */
export async function computeMemoryStatus(instanceIdOrSlug: string): Promise<MemoryStatus> {
  const instance = await findInstanceByIdOrSlug(instanceIdOrSlug);
  if (!instance) return OFF;
  return computeMemoryStatusFromInstance(instance);
}
