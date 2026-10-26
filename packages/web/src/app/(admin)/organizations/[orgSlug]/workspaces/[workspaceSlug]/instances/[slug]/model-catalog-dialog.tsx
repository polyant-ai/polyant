// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { ListHead, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { useListView } from "@/components/use-list-view";
import { ListNoResults } from "@/components/list-states";
import type { ModelsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import type { TranslationKey } from "@/lib/i18n/types";
import { BRAND_NAMES } from "@/lib/provider-secrets";
import { cn } from "@/lib/utils";

// Model-catalog dialog: a flattened row (model + its provider) and the
// column keys the table can sort by.
type CatalogRow = ModelsResponse["providers"][string]["models"][number] & { provider: string };
type CatalogSortKey = "provider" | "model" | "input" | "output" | "cacheRead" | "cacheWrite";

function catalogSortValue(row: CatalogRow, key: CatalogSortKey): string | number {
  switch (key) {
    case "provider":
      return BRAND_NAMES[row.provider] ?? row.provider;
    case "model":
      return row.id;
    case "input":
      return row.costInput;
    case "output":
      return row.costOutput;
    case "cacheRead":
      return row.costCacheRead;
    case "cacheWrite":
      return row.costCacheWrite;
  }
}

interface Props {
  modelsData: ModelsResponse;
  /** The providers this agent may be pointed at, for the filter. */
  providerNames: readonly string[];
  selectedProvider: string;
  selectedModel: string;
  /** A row was clicked: the dialog closes on its own. */
  onSelect: (provider: string, model: string) => void;
}

/**
 * Every model the deployment serves with its prices, searchable, filterable by
 * provider and sortable by column; a row picks that provider and model.
 */
export function ModelCatalogDialog({ modelsData, providerNames, selectedProvider, selectedModel, onSelect }: Props) {
  const { t } = useI18n();
  const fmt = useFormat();
  // Model catalog dialog: search + provider filter + column sort over a single
  // flattened table (was one table per provider, which overflowed).
  const [pricingOpen, setPricingOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogProvider, setCatalogProvider] = useState("all");
  const [catalogSort, setCatalogSort] = useState<{ key: CatalogSortKey; dir: "asc" | "desc" }>({
    key: "provider",
    dir: "asc",
  });

  // Flatten → filter (provider, then search) → sort by the column the reader chose.
  const providerRows = useMemo<CatalogRow[]>(() => {
    if (!modelsData) return [];
    return Object.entries(modelsData.providers)
      .flatMap(([providerName, { models }]) => models.map((m) => ({ ...m, provider: providerName })))
      .filter((m) => catalogProvider === "all" || m.provider === catalogProvider);
  }, [modelsData, catalogProvider]);
  const searched = useListView(providerRows, catalogSearch, (m) => [m.id, m.tier, BRAND_NAMES[m.provider] ?? m.provider], null);
  const catalogRows = useMemo<CatalogRow[]>(() => {
    const dir = catalogSort.dir === "asc" ? 1 : -1;
    return [...searched].sort((a, b) => {
      const av = catalogSortValue(a, catalogSort.key);
      const bv = catalogSortValue(b, catalogSort.key);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [searched, catalogSort]);

  const toggleCatalogSort = (key: CatalogSortKey) =>
    setCatalogSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "provider" || key === "model" ? "asc" : "desc" },
    );

  // Sortable column header: label + direction arrow, toggles sort on click.
  const catalogSortHead = (
    labelKey: TranslationKey,
    key: CatalogSortKey,
    opts?: { width?: string; right?: boolean },
  ) => {
    const active = catalogSort.key === key;
    const Arrow = active ? (catalogSort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
    // whitespace-normal so long labels (e.g. "Cache scrittura") wrap inside the
    // fixed column instead of overflowing into the next one; the button is w-full
    // so the flex constrains the label to the cell width.
    return (
      <ListHead className={cn("align-bottom whitespace-normal", opts?.width)} align={opts?.right ? "end" : undefined}>
        <button
          type="button"
          onClick={() => toggleCatalogSort(key)}
          className={cn(
            "flex w-full items-center gap-1 hover:text-foreground",
            opts?.right ? "justify-end" : "justify-start",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span>{t(labelKey)}</span>
          <Arrow className={cn("h-3 w-3 shrink-0", !active && "opacity-40")} />
        </button>
      </ListHead>
    );
  };

  return (
    <Dialog open={pricingOpen} onOpenChange={setPricingOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
          <Info className="h-3.5 w-3.5" />
          {t("settings.tab.viewPricing")}
        </Button>
      </DialogTrigger>
      {/* sm:max-w-6xl (with the sm: variant) is required to override
          shadcn's default sm:max-w-lg — a plain max-w-6xl is a different
          variant, so tailwind-merge keeps both and the narrow default wins
          from the sm breakpoint up. */}
      <DialogContent className="max-h-[85vh] w-[95vw] sm:max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.tab.pricingTitle")}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t("settings.tab.pricingClickHint")}</p>
        </DialogHeader>
        <div className="space-y-4">
          {/* Toolbar: free-text search + provider filter */}
          <div>
          <ListToolbar value={catalogSearch} onChange={setCatalogSearch} label={t("settings.tab.catalogSearchPlaceholder")}>
            <Select value={catalogProvider} onValueChange={setCatalogProvider}>
              <SelectTrigger className="sm:w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("settings.tab.catalogAllProviders")}</SelectItem>
                {providerNames.map((p) => (
                  <SelectItem key={p} value={p}>
                    {BRAND_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ListToolbar>

          {/* Single flattened table with a Provider column. table-fixed so the
              model-id column absorbs the leftover width and long IDs wrap
              (break-all) instead of overflowing into the price columns. */}
          {catalogRows.length === 0 ? (
            <ListNoResults>{t("settings.tab.catalogNoResults")}</ListNoResults>
          ) : (
            <ListTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {catalogSortHead("settings.tab.model", "model")}
                  {catalogSortHead("settings.tab.provider", "provider", { width: "w-28" })}
                  {catalogSortHead("settings.tab.pricingInput", "input", { width: "w-20", right: true })}
                  {catalogSortHead("settings.tab.pricingOutput", "output", { width: "w-20", right: true })}
                  {catalogSortHead("settings.tab.pricingCacheRead", "cacheRead", { width: "w-24", right: true })}
                  {catalogSortHead("settings.tab.pricingCacheWrite", "cacheWrite", { width: "w-24", right: true })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogRows.map((m) => {
                  const isSelected = selectedProvider === m.provider && selectedModel === m.id;
                  const pick = () => {
                    onSelect(m.provider, m.id);
                    setPricingOpen(false);
                  };
                  // A cache rate "doesn't count" when it's free (0) or billed at the
                  // full input rate (no discount — Nebius / non-cacheable models): show
                  // "—" instead of a figure that implies a saving.
                  const fmtCache = (v: number | undefined) => {
                    const val = v ?? m.costInput;
                    return val === 0 || val === m.costInput ? "—" : fmt.currency(val);
                  };
                  return (
                    <ListRow key={`${m.provider}:${m.id}`} onOpen={pick} selected={isSelected}>
                      <ListNameCell
                        name={m.id}
                        onOpen={pick}
                        badges={m.tier ? <Badge variant="secondary">{m.tier}</Badge> : undefined}
                        summary={
                          m.costLongPrompt
                            ? t("settings.tab.catalogLongPrompt", {
                                above: Math.round(m.costLongPrompt.above / 1000),
                                input: fmt.currency(m.costLongPrompt.costInput),
                                output: fmt.currency(m.costLongPrompt.costOutput),
                              })
                            : undefined
                        }
                      />
                      <TableCell className="align-top">
                        {BRAND_NAMES[m.provider] ?? m.provider.charAt(0).toUpperCase() + m.provider.slice(1)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt.currency(m.costInput)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt.currency(m.costOutput)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtCache(m.costCacheRead)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtCache(m.costCacheWrite)}</TableCell>
                    </ListRow>
                  );
                })}
              </TableBody>
            </ListTable>
          )}
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.tab.pricingNote")}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
