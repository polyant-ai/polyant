// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Cpu, Settings2, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type ChannelConfig, type Instance, type SkillState, type ToolState } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { StatusChecks } from "./status-checks-list";

/**
 * Where the agent opens: whether it is WELL, and then what it is.
 *
 * The checks come first because they are the only part that changes on its own,
 * and therefore the reason to come back to this page. Everything under them is a
 * read-only account of the configuration — the same facts the sections below hold,
 * gathered so the answer to "how is this agent set up" is one screen instead of
 * eight.
 *
 * Two rules the layout encodes:
 *
 * **Every block links to the section that sets it.** Read-only is right — nothing
 * here should be editable in two places — but a status page is exactly where you
 * decide to go and change something. That also makes this the one page that
 * navigates the agent by SUBJECT rather than by section name.
 *
 * **A fact that failed to load reads as unknown, never as absent.** "No channels"
 * and "could not read the channels" are different answers, and only one of them
 * means the agent is unreachable.
 */
export function StatusTab({
  instance,
  tools,
  skills,
}: {
  instance: Instance;
  /** Already loaded by the page — the checks read them, this page does not fetch them again. */
  tools: ToolState[];
  skills: SkillState[];
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [channels, setChannels] = useState<ChannelConfig[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.channels.list(instance.slug);
        if (!cancelled) setChannels(res.channels);
      } catch {
        // Reading channels is admin-and-above. A viewer gets the rest of the page
        // and an "unknown" here, not a page-wide error.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instance.slug]);

  const section = (tab: string) => `${pathname}?tab=${tab}`;
  const liveChannels = (channels ?? []).filter((c) => c.enabled).map((c) => c.channelType);

  return (
    <div className="space-y-10">
      <StatusChecks instance={instance} tools={tools} skills={skills} />

      <div className="space-y-6">
        <div>
          <h3 className="text-xl font-semibold">{t("status.current.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("status.current.description")}</p>
        </div>

        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          <Block
            icon={<Cpu className="h-4 w-4" />}
            title={t("status.current.systemDetails")}
            href={section("settings")}
            configureLabel={t("common.configure")}
          >
            <Row label={t("status.current.providerModel")}>
              <span className="font-mono text-xs">
                {instance.provider ?? "—"} / {instance.model ?? "—"}
              </span>
            </Row>
            <Row label={t("status.current.status")}>
              <Badge variant={instance.status === "active" ? "default" : "secondary"}>
                {instance.status}
              </Badge>
            </Row>
          </Block>

          <Block
            icon={<Settings2 className="h-4 w-4" />}
            title={t("status.current.capabilities")}
            href={section("tools")}
            configureLabel={t("common.configure")}
          >
            {/* Counted from the SERVED list: a tool the runtime skips is not a
                capability, whatever the assignment table says. */}
            <Row label={t("status.current.tools")}>
              {tools.filter((tool) => tool.enabled).length}
            </Row>
            <Row label={t("status.current.skills")}>
              {skills.filter((skill) => skill.enabled).length}
            </Row>
            <Row label={t("status.current.channels")}>
              {loading ? (
                <Skeleton className="h-4 w-20" />
              ) : channels === null ? (
                <Unknown t={t} />
              ) : liveChannels.length === 0 ? (
                // Named, not counted: "0 channels" and "reachable only from the
                // panel" read the same as a number, and an agent nobody can reach
                // is the one status fact nothing else on this page states.
                <span className="text-muted-foreground">{t("overview.status.noChannels")}</span>
              ) : (
                <span className="flex flex-wrap justify-end gap-1">
                  {liveChannels.map((c) => (
                    <Badge key={c} variant="secondary">
                      {c}
                    </Badge>
                  ))}
                </span>
              )}
            </Row>
            <Row label={t("status.current.memory")}>
              <OnOff on={instance.memoryEnabled} t={t} />
            </Row>
            <Row label={t("status.current.knowledge")}>
              <OnOff on={instance.knowledgeEnabled} t={t} />
            </Row>
          </Block>

          {/* Every row here changes what the agent does per turn, and each was
              otherwise findable only by opening the section that sets it. */}
          <Block
            icon={<SlidersHorizontal className="h-4 w-4" />}
            title={t("instances.detail.tabParams")}
            href={section("params")}
            configureLabel={t("common.configure")}
          >
            <Row label={t("settings.tab.thinking")}>
              {instance.thinkingEnabled ? (
                <span className="flex items-center gap-1">
                  <OnOff on t={t} />
                  <span className="text-xs text-muted-foreground">
                    {instance.thinkingLevel ?? "medium"}
                  </span>
                </span>
              ) : (
                <OnOff on={false} t={t} />
              )}
            </Row>
            <Row label={t("settings.temperature.label")}>
              {instance.temperature ?? (
                <span className="text-muted-foreground">
                  {t("settings.temperature.placeholder")}
                </span>
              )}
            </Row>
            <Row label={t("settings.tab.cache")}>
              {instance.cacheEnabled ? (
                <span className="flex items-center gap-1">
                  <OnOff on t={t} />
                  <span className="text-xs text-muted-foreground">{instance.cacheTtl}</span>
                </span>
              ) : (
                <OnOff on={false} t={t} />
              )}
            </Row>
            <Row label={t("settings.tab.stateInPrompt")}>
              <OnOff on={instance.stateInPromptEnabled} t={t} />
            </Row>
            <Row label={t("settings.tab.debug")}>
              <OnOff on={instance.debugEnabled ?? false} t={t} />
            </Row>
          </Block>
        </div>
      </div>
    </div>
  );
}

/**
 * One subject of the agent, read-only, with the way to its section.
 *
 * `border` rather than a tinted fill: a grey panel floating on the page
 * background reads as disabled, and every other block in the panel is a bordered
 * one.
 */
function Block({
  icon,
  title,
  href,
  configureLabel,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  href: string;
  configureLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        <Link
          href={href}
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-accent-strong"
        >
          {configureLabel}
        </Link>
      </div>
      <dl className="space-y-1 text-sm">{children}</dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function OnOff({ on, t }: { on: boolean; t: (key: TranslationKey) => string }) {
  return <Badge variant={on ? "default" : "secondary"}>{on ? t("common.on") : t("common.off")}</Badge>;
}

/** A fact that failed to load reads as unknown, never as absent. */
function Unknown({ t }: { t: (key: TranslationKey) => string }) {
  return <span className="text-muted-foreground">{t("overview.status.unknown")}</span>;
}
