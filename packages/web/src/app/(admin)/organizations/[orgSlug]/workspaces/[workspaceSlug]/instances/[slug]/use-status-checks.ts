// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import {
  api,
  type ChannelConfig,
  type Instance,
  type InstanceHook,
  type KnowledgeDocument,
  type RoomConfigResponse,
  type SecretStatus,
  type SkillState,
  type ToolState,
} from "@/lib/api";
import { parseUTC } from "@/lib/format";
import { runStatusChecks, statusVerdict, type AgentCheck } from "./status-checks";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Collects everything `runStatusChecks` needs and runs it.
 *
 * Seven requests, all GET, all in parallel, all ALLOWED TO FAIL: each check reads
 * `null` as "I could not look" and stays silent, so a viewer who cannot read
 * secrets sees the checks that do not need them rather than a page-wide error.
 * That is also why this hook returns no error state — a failed fetch here costs
 * a check, never the page.
 *
 * The fetches are deliberately not shared with the sections that also make them:
 * this page is the landing page, the sections are not mounted, and a cache layer
 * for seven GETs is a bigger thing than seven GETs.
 */
export function useStatusChecks({
  instance,
  tools,
  skills,
}: {
  instance: Instance;
  tools: ToolState[];
  skills: SkillState[];
}): { checks: AgentCheck[]; verdict: ReturnType<typeof statusVerdict>; loading: boolean } {
  const [checks, setChecks] = useState<AgentCheck[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const slug = instance.slug;

    (async () => {
      const [secrets, channels, documents, hooks, hookFunctions, room, optOuts] =
        await Promise.allSettled([
          api.secrets.list(slug),
          api.channels.list(slug),
          api.knowledge.list(slug),
          api.hooks.list(slug),
          api.hooks.functions(),
          api.room.get(slug),
          api.optouts.list(slug, { status: "opted_out" }),
        ]);

      if (cancelled) return;

      const value = <T,>(r: PromiseSettledResult<T>): T | null =>
        r.status === "fulfilled" ? r.value : null;

      const since = Date.now() - SEVEN_DAYS_MS;
      const optOutList = value(optOuts)?.optouts ?? null;

      setChecks(
        runStatusChecks({
          instance,
          tools,
          skills,
          optedOutCount: optOutList === null ? null : optOutList.length,
          secrets: (value(secrets)?.secrets ?? null) as SecretStatus[] | null,
          channels: (value(channels)?.channels ?? null) as ChannelConfig[] | null,
          documents: (value(documents)?.documents ?? null) as KnowledgeDocument[] | null,
          hooks: (value(hooks)?.hooks ?? null) as InstanceHook[] | null,
          hookFunctions: value(hookFunctions)?.hookFunctions.map((f) => f.name) ?? null,
          room: value(room) as RoomConfigResponse | null,
          // Only the recent ones: a count since the beginning of time never falls,
          // so it would light up once and stay lit for good.
          recentOptOuts:
            optOutList === null
              ? null
              : optOutList.filter(
                  (c) => c.updatedAt !== null && parseUTC(c.updatedAt).getTime() >= since,
                ).length,
        }),
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [instance, tools, skills]);

  return { checks, verdict: statusVerdict(checks), loading };
}
