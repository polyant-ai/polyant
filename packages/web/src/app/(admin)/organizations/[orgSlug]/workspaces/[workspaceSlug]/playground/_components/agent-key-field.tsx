// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/context";

/** The agent's key, asked of a user who can read the agent but not edit it. */
export function AgentKeyField({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);

  return (
    <div className="relative max-w-xs flex-1">
      <Input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("playground.authKeyPlaceholder")}
        aria-label={t("playground.authKeyLabel")}
        title={t("playground.authKeyHint")}
        className="h-8 pr-8 text-xs"
      />
      <button
        type="button"
        onClick={() => setShown(!shown)}
        aria-label={t(shown ? "playground.authKeyHide" : "playground.authKeyShow")}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
