// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import type { RequiredSecretSpec } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { BRAND_NAMES } from "@/lib/provider-secrets";
import { SecretField, SecretStatusBadge } from "./secret-field";
import type { SecretSpecsForm } from "./use-secret-specs";

/**
 * The fields a tool or hook declares in `requiredSecrets`, rendered one way
 * wherever they appear. They used to be drawn only by the agent's settings form;
 * now the tool's own panel and the hooks page draw them too, beside the thing
 * that asks for them.
 */

/** What a key reads as when its declaration carries no `label`. */
export function humanizeSecretKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => {
      const lower = w.toLowerCase();
      if (lower === "api") return "API";
      if (lower === "key") return "Key";
      return BRAND_NAMES[lower] ?? w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export function RemoveKeyButton({ onRemove }: { onRemove: () => void }) {
  const { t } = useI18n();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("common.delete")} className="shrink-0 text-destructive">
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("settings.tab.removeKeyTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("settings.tab.removeKeyDescription")}</AlertDialogDescription>
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
  );
}

// ── Readable field ─────────────────────────────────────────────────────
// For a field declared `sensitive: false` (a base URL, a region): cleartext,
// prefilled from the stored value, no visibility toggle.

export interface ReadableFieldProps {
  label: string;
  sublabel?: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
  placeholder: string;
  onRemove?: () => void;
  id?: string;
}

export function ReadableField({ label, sublabel, value, onChange, configured, placeholder, onRemove, id }: ReadableFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        <SecretStatusBadge configured={configured} />
      </div>
      {sublabel && <p className="text-xs text-muted-foreground">{sublabel}</p>}
      <div className="flex gap-2">
        <Input
          id={id}
          type="text"
          className="flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {onRemove && <RemoveKeyButton onRemove={onRemove} />}
      </div>
    </div>
  );
}

// ── Select field ───────────────────────────────────────────────────────

export interface SecretSelectFieldProps {
  label: string;
  description?: string;
  configured: boolean;
  value: string;
  choices: string[];
  onChange: (value: string) => void;
  id?: string;
}

export function SecretSelectField({ label, description, configured, value, choices, onChange, id }: SecretSelectFieldProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        <Badge variant={configured ? "default" : "secondary"} className="text-xs">
          {configured ? t("settings.tab.configured") : t("settings.tab.notConfigured")}
        </Badge>
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── One declared field, whatever its type ──────────────────────────────

/**
 * Picks the control from the declaration: `select` → dropdown, `sensitive:
 * false` → cleartext, anything else → masked. The description falls back to a
 * sentence saying the author gave none, so a reader can tell "nothing to
 * explain" apart from "the plugin did not say".
 */
export function SecretSpecField({ spec, form }: { spec: RequiredSecretSpec; form: SecretSpecsForm }) {
  const { t } = useI18n();
  const label = spec.label ?? humanizeSecretKey(spec.key);
  const description = spec.description ?? t("tools.paramNoDescription");
  const configured = form.isConfigured(spec.key);
  const id = `secret-${spec.key}`;
  const placeholder = configured ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder");
  // A cleartext field (a URL, a list of domains) is not a key: "sk-…" would mislead.
  const readablePlaceholder = configured ? t("settings.tab.keyPlaceholderSet") : "";
  const onRemove = configured ? () => void form.remove(spec.key) : undefined;

  if (spec.type === "select") {
    return (
      <SecretSelectField
        id={id}
        label={label}
        description={description}
        configured={configured}
        value={form.value(spec.key)}
        choices={spec.choices ?? []}
        onChange={(v) => form.setValue(spec.key, v)}
      />
    );
  }
  if (spec.sensitive === false) {
    return (
      <ReadableField
        id={id}
        label={label}
        sublabel={description}
        value={form.value(spec.key)}
        onChange={(v) => form.setValue(spec.key, v)}
        configured={configured}
        placeholder={readablePlaceholder}
        onRemove={onRemove}
      />
    );
  }
  return (
    <SecretField
      label={label}
      sublabel={description}
      value={form.value(spec.key)}
      onChange={(v) => form.setValue(spec.key, v)}
      configured={configured}
      visible={form.visible(spec.key)}
      onToggleVisibility={() => form.toggleVisibility(spec.key)}
      placeholder={placeholder}
      onRemove={onRemove}
    />
  );
}
