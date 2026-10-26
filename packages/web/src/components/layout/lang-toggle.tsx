// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useI18n } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check } from "lucide-react";
import type { Locale } from "@/lib/i18n/types";

function FlagIT({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 15" className={className} aria-hidden="true">
      <defs>
        <clipPath id="flagItClip">
          <rect width="21" height="15" rx="2" />
        </clipPath>
      </defs>
      <g clipPath="url(#flagItClip)">
        <rect width="21" height="15" fill="#fff" />
        <rect width="7" height="15" fill="#009246" />
        <rect x="14" width="7" height="15" fill="#CE2B37" />
      </g>
    </svg>
  );
}

function FlagGB({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 15" className={className} aria-hidden="true">
      <defs>
        <clipPath id="flagGbClip">
          <rect width="21" height="15" rx="2" />
        </clipPath>
      </defs>
      <g clipPath="url(#flagGbClip)">
        <rect width="21" height="15" fill="#012169" />
        <path d="M0 0L21 15M21 0L0 15" stroke="#fff" strokeWidth="3" />
        <path d="M0 0L21 15M21 0L0 15" stroke="#C8102E" strokeWidth="1.5" />
        <path d="M10.5 0V15M0 7.5H21" stroke="#fff" strokeWidth="5" />
        <path d="M10.5 0V15M0 7.5H21" stroke="#C8102E" strokeWidth="3" />
      </g>
    </svg>
  );
}

const LANGUAGES: { locale: Locale; flag: React.FC<{ className?: string }>; label: string }[] = [
  { locale: "it", flag: FlagIT, label: "Italiano" },
  { locale: "en", flag: FlagGB, label: "English" },
];

export function LangToggle() {
  const { locale, setLocale, t } = useI18n();
  const current = LANGUAGES.find((l) => l.locale === locale) ?? LANGUAGES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label={t("common.language")}>
          <current.flag className="w-5 h-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.locale}
            onClick={() => setLocale(lang.locale)}
            className="gap-2"
          >
            <lang.flag className="w-5 h-3.5" />
            <span>{lang.label}</span>
            {locale === lang.locale && <Check className="ml-auto size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
