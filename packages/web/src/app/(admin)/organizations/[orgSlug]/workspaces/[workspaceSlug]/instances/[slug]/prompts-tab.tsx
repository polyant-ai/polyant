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
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Chip } from "@/components/ui/chip";
import { api, getUserErrorMessage, type PromptSection } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { usePageSaveAction } from "./page-actions-context";

const PROMPT_ICONS: Record<string, React.ElementType> = {
  "01-identity": User,
  "02-soul": Heart,
  "03-tooling": Wrench,
  "04-safety": Shield,
  "05-skills": Sparkles,
  "06-memory": Brain,
  "07-user-identity": UserCircle,
};

/**
 * The seven sections every agent is created with are DB rows titled in English
 * (the engine seeds `Identity`, `Soul`, ...). The panel shows a translated label
 * and a one-line description for those keys; a section the author added shows
 * its own title.
 */
const DEFAULT_SECTION_COPY: Record<string, { label: TranslationKey; description: TranslationKey }> = {
  "01-identity": { label: "prompts.section.identity", description: "prompts.section.identity.description" },
  "02-soul": { label: "prompts.section.soul", description: "prompts.section.soul.description" },
  "03-tooling": { label: "prompts.section.tooling", description: "prompts.section.tooling.description" },
  "04-safety": { label: "prompts.section.safety", description: "prompts.section.safety.description" },
  "05-skills": { label: "prompts.section.skills", description: "prompts.section.skills.description" },
  "06-memory": { label: "prompts.section.memory", description: "prompts.section.memory.description" },
  "07-user-identity": { label: "prompts.section.userIdentity", description: "prompts.section.userIdentity.description" },
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

  const sectionLabel = (prompt: PromptSection) => {
    const copy = DEFAULT_SECTION_COPY[prompt.key];
    return copy ? t(copy.label) : prompt.title;
  };

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
    <div>
      {/*
        ANCHORS, in a row — not a second column.

        This was a 224px rail of icon+label rows down the left of the content, which
        with the agent's sections in the sidebar put two vertical columns of nav
        rows side by side: the exact shape the panel's navigation removed one level
        up, reintroduced inside a section. Same job (jump to a section, see which
        one is dirty), one axis, and it works on a phone, which the hidden-on-mobile
        rail did not.

        The active chip is `primary`, not the lime accent: the accent is the chart
        series colour elsewhere on this page, and one colour meaning both "this data
        series" and "this selection" is what made it ambiguous.
      */}
      <nav
        aria-label={t("prompts.sidebarTitle")}
        className="sticky top-0 z-10 -mx-1 mb-6 flex gap-2 overflow-x-auto bg-background px-1 py-2"
      >
        {prompts.map((prompt) => {
          const Icon = PROMPT_ICONS[prompt.key] ?? Sparkles;
          const active = activeKey === prompt.key;
          const dirty = dirtyKeys.has(prompt.key);
          return (
            <Chip
              key={prompt.key}
              active={active}
              size="sm"
              onClick={() => scrollTo(prompt.key)}
              aria-current={active ? "true" : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{sectionLabel(prompt)}</span>
              {dirty && (
                <span
                  aria-label={t("prompts.modified")}
                  className="size-1.5 shrink-0 rounded-full bg-accent"
                />
              )}
            </Chip>
          );
        })}
      </nav>

      {/* Stacked sections — always expanded, scroll to navigate. */}
      {/* No max-width and no flex column: the section rail became a row of
          anchors above, so the editors take the full page width. */}
      <div className="min-w-0">
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
                  <h3 className="text-base font-semibold">{sectionLabel(prompt)}</h3>
                  {dirty && (
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {t("prompts.modified")}
                    </Badge>
                  )}
                </header>
                {DEFAULT_SECTION_COPY[prompt.key] && (
                  <p className="mb-3 text-sm text-muted-foreground">
                    {t(DEFAULT_SECTION_COPY[prompt.key].description)}
                  </p>
                )}
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
