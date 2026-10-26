// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useEffect, useRef } from "react";
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
  /** The display name of the selected agent, or null while none is. */
  onNameChange?: (name: string | null) => void;
  disabled?: boolean;
}

export function InstanceSelector({
  value,
  onChange,
  onNameChange,
  disabled,
}: InstanceSelectorProps) {
  const { t } = useI18n();
  const [instances, setInstances] = useState<Instance[]>([]);

  useEffect(() => {
    api.instances
      .list()
      .then((res) =>
        setInstances(
          res.instances.filter((inst) => inst.status === "active"),
        ),
      )
      .catch(() => {});
  }, []);

  // The parent's handlers change identity on every render; the effects below
  // depend on what the list and the selection ARE, not on which closure holds them.
  const onChangeRef = useRef(onChange);
  const onNameChangeRef = useRef(onNameChange);
  useEffect(() => {
    onChangeRef.current = onChange;
    onNameChangeRef.current = onNameChange;
  });

  // Auto-select the first agent once, when none is selected.
  useEffect(() => {
    if (!value && instances.length > 0) onChangeRef.current(instances[0].slug);
  }, [value, instances]);

  const selectedName = instances.find((inst) => inst.slug === value)?.name ?? null;
  useEffect(() => {
    onNameChangeRef.current?.(selectedName);
  }, [selectedName]);

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
