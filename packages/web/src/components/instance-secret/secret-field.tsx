// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Eye, EyeOff, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/lib/i18n/context";

/**
 * One masked credential field, with its status and its removal.
 *
 * Lifted out of the agent's model settings unchanged. It was already purely
 * presentational — value in, `onChange` out — but it lived inside a
 * 1500-line form, so every other tab that needed a credential would have had to
 * copy it. Pair it with `useInstanceSecret`, which owns the state it renders.
 *
 * A credential here is the AGENT's, full stop. Enterprise adds a second source —
 * an organization's shared keys — and shows it as a fact of its own beside
 * `configured`, because reporting "not configured" about a working credential is
 * how someone pastes a second copy of a key they already have.
 */
export function SecretStatusBadge({ configured }: { configured: boolean }) {
  const { t } = useI18n();
  return configured ? (
    <Badge variant="default" className="text-xs">
      {t("settings.tab.configured")}
    </Badge>
  ) : (
    <Badge variant="secondary" className="text-xs">
      {t("settings.tab.notConfigured")}
    </Badge>
  );
}

export interface SecretFieldProps {
  label: string;
  sublabel?: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
  visible: boolean;
  onToggleVisibility: () => void;
  placeholder: string;
  /** Omitted hides the remove control — a key that is not set has nothing to remove. */
  onRemove?: () => void;
}

export function SecretField({
  label,
  sublabel,
  value,
  onChange,
  configured,
  visible,
  onToggleVisibility,
  placeholder,
  onRemove,
}: SecretFieldProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        <SecretStatusBadge configured={configured} />
      </div>
      {sublabel && <p className="text-xs text-muted-foreground">{sublabel}</p>}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={visible ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
          />
          {/* Icon-only, so it needs a name: without one a screen reader reads
              "button" and the only way to learn what it does is to press it. */}
          <button
            type="button"
            onClick={onToggleVisibility}
            aria-label={t(visible ? "common.hide" : "common.show")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {onRemove && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common.delete")}
                className="shrink-0 text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("settings.tab.removeKeyTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.tab.removeKeyDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onRemove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t("settings.tab.removeKey")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
