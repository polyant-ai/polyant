// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n/context";

/** 32 random bytes as hex — matches the strength of the server webhook token. */
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Props {
  /** Masked current value (••••last4) from the list endpoint, or "" when unset. */
  currentMasked: string;
  /** Persist the new secret; "" clears it (disables auth). */
  onSave: (authKey: string) => void;
}

export function WebhookAuthSection({ currentMasked, onSave }: Props) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const isProtected = currentMasked.length > 0;

  function handleSave() {
    onSave(value);
    setEditing(false);
    setValue("");
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">{t("room.sources.auth")}</Label>
        <Badge variant={isProtected ? "default" : "secondary"} className="text-xs">
          {isProtected ? t("room.sources.authProtected") : t("room.sources.authNone")}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t("room.sources.authHelp")}</p>

      {editing ? (
        <div className="flex items-center gap-2">
          <Input
            className="h-8 text-sm font-mono"
            value={value}
            placeholder={t("room.sources.authInputPlaceholder")}
            onChange={(e) => setValue(e.target.value)}
          />
          {value && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              onClick={() => {
                navigator.clipboard.writeText(value);
                toast.success(t("room.sources.authCopied"));
              }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          )}
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setValue(generateSecret())}>
            {t("room.sources.authGenerate")}
          </Button>
          <Button size="sm" className="shrink-0" onClick={handleSave} disabled={!value}>
            {t("common.save")}
          </Button>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => { setEditing(false); setValue(""); }}>
            {t("common.cancel")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {isProtected && <code className="text-xs bg-muted rounded px-2 py-1">{currentMasked}</code>}
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {isProtected ? t("room.sources.authChange") : t("room.sources.authSet")}
          </Button>
          {isProtected && (
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onSave("")}>
              {t("room.sources.authRemove")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
