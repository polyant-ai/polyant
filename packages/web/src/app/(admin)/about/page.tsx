// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  BookOpen,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  PackageSearch,
  Scale,
} from "lucide-react";
import { useSession } from "next-auth/react";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ChangelogEntryCard } from "@/components/layout/changelog-entry-card";
import { useI18n } from "@/lib/i18n/context";
import { releaseInfo } from "@/lib/release-info";
import { isPlatformAdminRole } from "@/lib/user-role";
import type { ChangelogEntry } from "@/lib/changelog-types";

const externalLinkProps = {
  target: "_blank",
  rel: "noreferrer",
};

function LinkRow({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <a
      className="group flex items-center gap-2 text-sm underline underline-offset-4 hover:text-accent-strong"
      href={href}
      {...externalLinkProps}
    >
      <Icon className="size-4 text-muted-foreground group-hover:text-accent-strong" />
      {label}
      <ExternalLink className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  );
}

export default function AboutPage() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const canViewChangelog = isPlatformAdminRole(session?.user?.role);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);

  useEffect(() => {
    if (!canViewChangelog) return;
    fetch("/changelog.json")
      .then((res) => res.json())
      .then((data: { changelog: ChangelogEntry[] }) => setChangelog(data.changelog))
      .catch(() => setChangelog([]));
  }, [canViewChangelog]);

  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row">
          <div className="flex shrink-0 flex-col gap-2 sm:w-40">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Bot className="size-4" />
              </div>
              <span className="text-lg font-semibold">Polyant</span>
            </div>

            <Badge variant="outline" className="w-fit font-mono">
              v{releaseInfo.version}
            </Badge>

            {releaseInfo.revision && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <GitCommitHorizontal className="size-3.5" />
                <code>{releaseInfo.revision}</code>
              </div>
            )}
          </div>

          <Separator orientation="vertical" className="hidden sm:block" />
          <Separator className="sm:hidden" />

          <div className="flex flex-1 flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t("about.description")}</p>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <LinkRow href={releaseInfo.repositoryUrl} icon={GitBranch} label={t("about.repository")} />
              <LinkRow href={releaseInfo.sdkUrl} icon={PackageSearch} label={t("about.sdk")} />
              <LinkRow href="https://polyant.ai" icon={Globe} label={t("about.website")} />
              <LinkRow href="https://docs.polyant.ai" icon={BookOpen} label={t("about.documentation")} />
              <LinkRow
                href="https://www.gnu.org/licenses/agpl-3.0.html"
                icon={Scale}
                label={`${t("about.license")}: AGPL-3.0`}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {canViewChangelog && changelog.length > 0 && (
        <Card className="mt-4">
          <CardContent className="space-y-3 p-4">
            <h2 className="text-lg font-semibold">{t("about.changelogTitle")}</h2>
            {changelog.map((entry, idx) => (
              <ChangelogEntryCard key={entry.version} entry={entry} defaultOpen={idx === 0} />
            ))}
          </CardContent>
        </Card>
      )}

      <p className="mt-6 text-center text-sm text-muted-foreground">
        {t("about.maintainedByPrefix")}{" "}
        <a
          className="text-accent-strong underline-offset-4 hover:underline"
          href="https://www.exelab.com/"
          {...externalLinkProps}
        >
          Exelab S.r.l.
        </a>
      </p>
    </div>
  );
}
