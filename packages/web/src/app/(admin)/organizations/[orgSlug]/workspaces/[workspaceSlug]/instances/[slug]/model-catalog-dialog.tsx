// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Info, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ModelsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
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
  // Model catalog dialog: search + provider filter + column sort over a single
  // flattened table (was one table per provider, which overflowed).
  const [pricingOpen, setPricingOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogProvider, setCatalogProvider] = useState("all");
  const [catalogSort, setCatalogSort] = useState<{ key: CatalogSortKey; dir: "asc" | "desc" }>({
    key: "provider",
    dir: "asc",
  });

  // Flatten → filter (search + provider) → sort for the catalog table.
  const catalogRows = useMemo<CatalogRow[]>(() => {
    if (!modelsData) return [];
    const flat: CatalogRow[] = Object.entries(modelsData.providers).flatMap(
      ([providerName, { models }]) => models.map((m) => ({ ...m, provider: providerName })),
    );
    const q = catalogSearch.trim().toLowerCase();
    const filtered = flat.filter(
      (m) =>
        (catalogProvider === "all" || m.provider === catalogProvider) &&
        (q === "" ||
          m.id.toLowerCase().includes(q) ||
          (m.tier ?? "").toLowerCase().includes(q) ||
          (BRAND_NAMES[m.provider] ?? m.provider).toLowerCase().includes(q)),
    );
    const dir = catalogSort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = catalogSortValue(a, catalogSort.key);
      const bv = catalogSortValue(b, catalogSort.key);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [modelsData, catalogSearch, catalogProvider, catalogSort]);

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
      <TableHead className={cn("align-bottom whitespace-normal", opts?.width, opts?.right && "text-right")}>
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
      </TableHead>
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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder={t("settings.tab.catalogSearchPlaceholder")}
                className="pl-8"
              />
            </div>
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
          </div>

          {/* Single flattened table with a Provider column. table-fixed so the
              model-id column absorbs the leftover width and long IDs wrap
              (break-all) instead of overflowing into the price columns. */}
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                {catalogSortHead("settings.tab.provider", "provider", { width: "w-28" })}
                {catalogSortHead("settings.tab.model", "model")}
                {catalogSortHead("settings.tab.pricingInput", "input", { width: "w-20", right: true })}
                {catalogSortHead("settings.tab.pricingOutput", "output", { width: "w-20", right: true })}
                {catalogSortHead("settings.tab.pricingCacheRead", "cacheRead", { width: "w-24", right: true })}
                {catalogSortHead("settings.tab.pricingCacheWrite", "cacheWrite", { width: "w-24", right: true })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {catalogRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                    {t("settings.tab.catalogNoResults")}
                  </TableCell>
                </TableRow>
              ) : (
                catalogRows.map((m) => {
                  const isSelected = selectedProvider === m.provider && selectedModel === m.id;
                  // A cache rate "doesn't count" when it's free (0) or billed at the
                  // full input rate (no discount — Nebius / non-cacheable models): show
                  // "—" instead of a figure that implies a saving.
                  const fmtCache = (v: number | undefined) => {
                    const val = v ?? m.costInput;
                    return val === 0 || val === m.costInput ? "—" : `$${val.toFixed(2)}`;
                  };
                  return (
                    <TableRow
                      key={`${m.provider}:${m.id}`}
                      className={cn("cursor-pointer", isSelected ? "bg-primary/10" : "hover:bg-muted/50")}
                      onClick={() => {
                        onSelect(m.provider, m.id);
                        setPricingOpen(false);
                      }}
                    >
                      <TableCell className="align-top text-xs">
                        {BRAND_NAMES[m.provider] ?? m.provider.charAt(0).toUpperCase() + m.provider.slice(1)}
                      </TableCell>
                      {/* whitespace-normal overrides shadcn's cell default of
                          whitespace-nowrap — without it break-all can't wrap and
                          long model ids overflow into the price columns. */}
                      <TableCell className="align-top whitespace-normal">
                        <span className="block break-all font-mono text-xs">{m.id}</span>
                        {m.tier && (
                          <Badge variant="secondary" className="mt-1 text-[10px]">
                            {m.tier}
                          </Badge>
                        )}
                        {m.costLongPrompt && (
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            {t("settings.tab.catalogLongPrompt", {
                              above: Math.round(m.costLongPrompt.above / 1000),
                              input: m.costLongPrompt.costInput.toFixed(2),
                              output: m.costLongPrompt.costOutput.toFixed(2),
                            })}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        ${m.costInput.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        ${m.costOutput.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {fmtCache(m.costCacheRead)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {fmtCache(m.costCacheWrite)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">{t("settings.tab.pricingNote")}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
