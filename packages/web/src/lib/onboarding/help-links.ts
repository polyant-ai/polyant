// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TranslationKey } from "@/lib/i18n/types";

/** External destinations of the Help menu. They open in a new tab. */
export const HELP_LINKS: readonly { id: string; href: string; labelKey: TranslationKey }[] = [
  { id: "docs", href: "https://docs.polyant.ai", labelKey: "onboarding.help.docs" },
  { id: "marketplace", href: "https://marketplace.polyant.ai", labelKey: "onboarding.help.marketplace" },
  { id: "polyant", href: "https://polyant.ai", labelKey: "onboarding.help.polyant" },
];
