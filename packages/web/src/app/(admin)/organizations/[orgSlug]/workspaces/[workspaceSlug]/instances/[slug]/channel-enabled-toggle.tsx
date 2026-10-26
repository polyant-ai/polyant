// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";

/**
 * ON/OFF as two joined buttons, not a switch: both options are stated and the one in
 * force is highlighted, with nothing to interpret. Every channel uses this one control
 * in this one place (right of its help text), Web included.
 */
export function ChannelEnabledToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t("channels.enabledLabel")} className="inline-flex shrink-0 overflow-hidden rounded-md border">
      {[true, false].map((on) => (
        <button
          key={String(on)}
          type="button"
          aria-pressed={enabled === on}
          disabled={disabled}
          onClick={() => onChange(on)}
          className={cn(
            "px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
            on ? "border-r" : undefined,
            enabled === on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary",
          )}
        >
          {t(on ? "common.on" : "common.off")}
        </button>
      ))}
    </div>
  );
}
