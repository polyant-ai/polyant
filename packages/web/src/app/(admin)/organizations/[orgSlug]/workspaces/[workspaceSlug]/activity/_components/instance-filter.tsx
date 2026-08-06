// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface InstanceFilterOption {
  id: string;
  name: string;
  icon: string | null;
}

interface Props {
  instances: InstanceFilterOption[];
  excluded: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  labels: {
    title: string;
    allSelected: string;
    someSelected: (visible: number, total: number) => string;
    selectAll: string;
    deselectAll: string;
  };
}

export function InstanceFilter({
  instances,
  excluded,
  onToggle,
  onSelectAll,
  onDeselectAll,
  labels,
}: Props) {
  const total = instances.length;
  const visibleCount = total - excluded.size;
  const summary = excluded.size === 0 ? labels.allSelected : labels.someSelected(visibleCount, total);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-2 text-xs">
          <Filter className="h-3.5 w-3.5" />
          {summary}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{labels.title}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            {labels.selectAll}
          </button>
          <button
            type="button"
            onClick={onDeselectAll}
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            {labels.deselectAll}
          </button>
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-y-auto">
          {instances.map((inst) => (
            <DropdownMenuCheckboxItem
              key={inst.id}
              checked={!excluded.has(inst.id)}
              onCheckedChange={() => onToggle(inst.id)}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="truncate">{inst.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
