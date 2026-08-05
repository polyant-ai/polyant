// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n/context";
import { releaseInfo } from "@/lib/release-info";

const externalLinkProps = {
  target: "_blank",
  rel: "noreferrer",
};

export default function AboutPage() {
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-semibold tracking-tight">
        {t("about.title", { version: releaseInfo.version })}
      </h1>
      <p className="mt-1 text-muted-foreground">{t("about.description")}</p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t("about.version")}</CardTitle>
          <CardDescription>{releaseInfo.version}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {releaseInfo.revision && (
            <p>
              <span className="text-muted-foreground">{t("about.revision")}: </span>
              <code>{releaseInfo.revision}</code>
            </p>
          )}
          <p>
            <span className="text-muted-foreground">{t("about.license")}: </span>
            <a
              className="text-primary underline-offset-4 hover:underline"
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              {...externalLinkProps}
            >
              AGPL-3.0
            </a>
          </p>
          <p>
            <a
              className="text-primary underline-offset-4 hover:underline"
              href={releaseInfo.releaseUrl}
              {...externalLinkProps}
            >
              {t("about.releaseNotes")}
            </a>
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Polyant</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={releaseInfo.repositoryUrl}
            {...externalLinkProps}
          >
            {t("about.repository")}
          </a>
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={releaseInfo.sdkUrl}
            {...externalLinkProps}
          >
            {t("about.sdk")}
          </a>
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="https://polyant.ai"
            {...externalLinkProps}
          >
            {t("about.website")}
          </a>
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="https://docs.polyant.ai"
            {...externalLinkProps}
          >
            {t("about.documentation")}
          </a>
        </CardContent>
      </Card>

      <p className="mt-6 text-sm text-muted-foreground">
        {t("about.maintainedBy", { company: "Exelab S.r.l." })} {" "}
        <a
          className="text-primary underline-offset-4 hover:underline"
          href="https://www.exelab.com/"
          {...externalLinkProps}
        >
          Exelab
        </a>
      </p>
    </div>
  );
}
