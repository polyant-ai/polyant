// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  User,
  Heart,
  Wrench,
  Shield,
  Sparkles,
  Brain,
  UserCircle,
  Clock,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, getUserErrorMessage, type PromptSection } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

const PROMPT_ICONS: Record<string, React.ElementType> = {
  "01-identity": User,
  "02-soul": Heart,
  "03-tooling": Wrench,
  "04-safety": Shield,
  "05-skills": Sparkles,
  "06-memory": Brain,
  "07-user-identity": UserCircle,
  "08-datetime": Clock,
};

interface Props {
  slug: string;
  prompts: PromptSection[];
  onUpdate: (prompts: PromptSection[]) => void;
}

export function PromptsTab({ slug, prompts, onUpdate }: Props) {
  const { t } = useI18n();
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [activeKey, setActiveKey] = useState<string>(prompts[0]?.key ?? "");

  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const handleChange = (key: string, content: string) => {
    setEdited((prev) => ({ ...prev, [key]: content }));
  };

  const dirtyKeys = useMemo(() => {
    const set = new Set<string>();
    for (const key of Object.keys(edited)) {
      const original = prompts.find((p) => p.key === key);
      if (original && edited[key] !== original.content) set.add(key);
    }
    return set;
  }, [edited, prompts]);

  const isDirty = dirtyKeys.size > 0;

  // Scroll-spy: highlight whichever section currently sits in the upper third
  // of the viewport. Re-attach the observer when the prompt list changes
  // (different instance, hot-reload).
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const key = (visible[0].target as HTMLElement).dataset.sectionKey;
          if (key) setActiveKey(key);
        }
      },
      { rootMargin: "-30% 0px -60% 0px", threshold: 0 },
    );
    Object.values(sectionRefs.current).forEach((el) => {
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [prompts]);

  const scrollTo = (key: string) => {
    const el = sectionRefs.current[key];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveKey(key);
  };

  const handleSave = async () => {
    const sections = Object.entries(edited)
      .filter(([key, content]) => {
        const original = prompts.find((p) => p.key === key);
        return original && content !== original.content;
      })
      .map(([key, content]) => ({ key, content }));

    if (sections.length === 0) return;

    setSaving(true);
    try {
      const { prompts: updated } = await api.prompts.update(slug, sections);
      onUpdate(updated);
      setEdited({});
      toast.success(t("prompts.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("prompts.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  return (
    <div className="flex gap-8">
      {/* Sticky navigation sidebar — desktop only. */}
      <nav className="hidden md:block w-56 shrink-0">
        <div className="sticky top-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("prompts.sidebarTitle")}
          </p>
          <ul className="space-y-1">
            {prompts.map((prompt) => {
              const Icon = PROMPT_ICONS[prompt.key] ?? Sparkles;
              const active = activeKey === prompt.key;
              const dirty = dirtyKeys.has(prompt.key);
              return (
                <li key={prompt.key}>
                  <button
                    type="button"
                    onClick={() => scrollTo(prompt.key)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate flex-1">{prompt.title}</span>
                    {dirty && (
                      <span
                        aria-label={t("prompts.modified")}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      {/* Stacked sections — always expanded, scroll to navigate. */}
      <div className="min-w-0 max-w-3xl flex-1">
        <p className="mb-6 text-sm text-muted-foreground">
          {t("prompts.description")}
        </p>
        <div className="space-y-10">
          {prompts.map((prompt) => {
            const Icon = PROMPT_ICONS[prompt.key] ?? Sparkles;
            const dirty = dirtyKeys.has(prompt.key);
            const value = edited[prompt.key] ?? prompt.content;
            return (
              <section
                key={prompt.key}
                ref={(el) => {
                  sectionRefs.current[prompt.key] = el;
                }}
                data-section-key={prompt.key}
                // Offset so smooth-scroll lands below the page header instead
                // of pinning the section title to the very top edge.
                className="scroll-mt-6"
              >
                <header className="mb-3 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-base font-semibold">{prompt.title}</h3>
                  {dirty && (
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {t("prompts.modified")}
                    </Badge>
                  )}
                </header>
                <Textarea
                  className="min-h-[240px] font-mono text-sm"
                  value={value}
                  onChange={(e) => handleChange(prompt.key, e.target.value)}
                />
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
