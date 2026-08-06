// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  BookOpen,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  PackageSearch,
  Scale,
} from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n/context";
import { releaseInfo } from "@/lib/release-info";

const externalLinkProps = {
  target: "_blank",
  rel: "noreferrer",
};

function LinkTile({
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
      className="group flex items-center gap-3 rounded-md border border-border p-3 transition-colors hover:border-accent-strong hover:bg-secondary"
      href={href}
      {...externalLinkProps}
    >
      <Icon className="size-4 text-muted-foreground group-hover:text-accent-strong" />
      <span className="flex-1 text-sm font-medium">{label}</span>
      <ExternalLink className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  );
}

export default function AboutPage() {
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("about.title", { version: releaseInfo.version })}
          </h1>
          <p className="text-muted-foreground">{t("about.description")}</p>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t("about.version")}</CardTitle>
          <CardDescription>{releaseInfo.version}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {releaseInfo.revision && (
            <div className="flex items-center gap-2">
              <GitCommitHorizontal className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t("about.revision")}:</span>
              <code className="rounded-sm bg-secondary px-1.5 py-0.5">{releaseInfo.revision}</code>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Scale className="size-4 text-muted-foreground" />
            <span className="text-muted-foreground">{t("about.license")}:</span>
            <a
              className="text-accent-strong underline-offset-4 hover:underline"
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              {...externalLinkProps}
            >
              AGPL-3.0
            </a>
          </div>
          <a
            className="inline-flex items-center gap-2 text-accent-strong underline-offset-4 hover:underline"
            href={releaseInfo.releaseUrl}
            {...externalLinkProps}
          >
            {t("about.releaseNotes")}
            <ExternalLink className="size-3.5" />
          </a>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Polyant</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <LinkTile href={releaseInfo.repositoryUrl} icon={GitBranch} label={t("about.repository")} />
          <LinkTile href={releaseInfo.sdkUrl} icon={PackageSearch} label={t("about.sdk")} />
          <LinkTile href="https://polyant.ai" icon={Globe} label={t("about.website")} />
          <LinkTile href="https://docs.polyant.ai" icon={BookOpen} label={t("about.documentation")} />
        </CardContent>
      </Card>

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
