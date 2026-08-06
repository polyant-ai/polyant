// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface InstanceSelectorProps {
  value: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
}

export function InstanceSelector({
  value,
  onChange,
  disabled,
}: InstanceSelectorProps) {
  const { t } = useI18n();
  const [instances, setInstances] = useState<Instance[]>([]);

  useEffect(() => {
    api.instances
      .list()
      .then((res) =>
        setInstances(
          res.agents.filter((inst) => inst.status === "active"),
        ),
      )
      .catch(() => {});
  }, []);

  // Auto-select first instance if none selected
  useEffect(() => {
    if (!value && instances.length > 0) {
      onChange(instances[0].slug);
    }
  }, [value, instances, onChange]);

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-[240px]">
        <SelectValue placeholder={t("playground.selectInstance")} />
      </SelectTrigger>
      <SelectContent>
        {instances.map((inst) => {
          const subtitle = [inst.provider, inst.model]
            .filter(Boolean)
            .join(" / ");
          return (
            <SelectItem key={inst.slug} value={inst.slug}>
              {inst.name}
              {subtitle && (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({subtitle})
                </span>
              )}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
