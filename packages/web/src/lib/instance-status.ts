// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TranslationKey } from "@/lib/i18n/types";

type TranslateFn = (key: TranslationKey) => string;

/**
 * An agent's stored status is an English word (`active`, `inactive`). Every place
 * that prints it goes through here so the label follows the UI language; a value
 * this panel does not know prints as stored rather than as a blank.
 */
export function instanceStatusLabel(status: string, t: TranslateFn): string {
  if (status === "active") return t("instances.status.active");
  if (status === "inactive") return t("instances.status.inactive");
  return status;
}
