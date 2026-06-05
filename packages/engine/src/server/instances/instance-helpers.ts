// SPDX-License-Identifier: AGPL-3.0-or-later

import { NotFoundException } from "@nestjs/common";
import { findInstanceBySlug } from "../../instances/store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

export { errMsg } from "../../utils/error.js";

/** Find instance or throw 404. Returns the instance record with id + slug. */
export async function findInstanceOrFail(slug: string) {
  const instance = await findInstanceBySlug(asInstanceSlug(slug));
  if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
  return instance;
}

/** Mask sensitive values in a config object for API responses. */
export function maskSensitiveConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const sensitivePattern = /(?:token|secret|password|key|credential)/i;
  const masked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (sensitivePattern.test(k) && typeof v === "string" && v.length > 0) {
      masked[k] = "••••" + v.slice(-4);
    } else {
      masked[k] = v;
    }
  }
  return masked;
}
