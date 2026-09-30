// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useRef } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/context";

/** One editable row of a field mapping: conversation state key ← payload dot-path. */
export interface MappingRow {
  id: number;
  key: string;
  path: string;
}

export function rowsFromMapping(mapping: Record<string, unknown>): MappingRow[] {
  return Object.entries(mapping).map(([key, path], id) => ({ id, key, path: String(path) }));
}

/** The mapping the rows describe: trimmed, rows without a key dropped (a blank row being typed). */
export function mappingFromRows(rows: readonly MappingRow[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) mapping[key] = row.path.trim();
  }
  return mapping;
}

interface Props {
  rows: readonly MappingRow[];
  onChange: (rows: MappingRow[]) => void;
  /** Placeholder of the payload column, which names what that channel's payload looks like. */
  pathPlaceholder: string;
}

/**
 * The row editor for a channel's field mapping: the engine projects each mapped
 * payload field onto the conversation state before the turn.
 */
export function FieldMappingEditor({ rows, onChange, pathPlaceholder }: Props) {
  const { t } = useI18n();
  const nextId = useRef(rows.reduce((max, row) => Math.max(max, row.id + 1), 0));
  const update = (id: number, change: Partial<MappingRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            value={row.key}
            placeholder={t("channels.tab.mappingStateKey")}
            aria-label={t("channels.tab.mappingStateKey")}
            onChange={(e) => update(row.id, { key: e.target.value })}
          />
          <span className="text-muted-foreground" aria-hidden>←</span>
          <Input
            value={row.path}
            placeholder={pathPlaceholder}
            aria-label={pathPlaceholder}
            onChange={(e) => update(row.id, { path: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-destructive shrink-0"
            aria-label={t("channels.tab.mappingRemove")}
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { id: nextId.current++, key: "", path: "" }])}
      >
        <Plus className="mr-2 h-4 w-4" />
        {t("channels.tab.mappingAdd")}
      </Button>
    </div>
  );
}
