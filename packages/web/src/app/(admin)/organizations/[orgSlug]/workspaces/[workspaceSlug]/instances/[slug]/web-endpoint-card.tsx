// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { TriangleAlert } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useI18n } from "@/lib/i18n/context";

/** The shell variable and the Node variable the examples read the key from; the key itself is never printed. */
const KEY_ENV = "AGENT_API_KEY";

/** Shell-quote with single quotes; the only character that needs care inside them is the quote itself. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCurlExample(url: string, slug: string, withKey: boolean): string {
  const body = JSON.stringify({ model: slug, messages: [{ role: "user", content: "Ciao" }] });
  const lines = [`curl ${shellQuote(url)}`, `  -H 'Content-Type: application/json'`];
  if (withKey) lines.push(`  -H "Authorization: Bearer $${KEY_ENV}"`);
  lines.push(`  -d ${shellQuote(body)}`);
  return lines.join(" \\\n");
}

export function buildFetchExample(url: string, slug: string, withKey: boolean): string {
  const headers = [`    "Content-Type": "application/json",`];
  if (withKey) headers.push("    Authorization: `Bearer ${process.env." + KEY_ENV + "}`,");
  return [
    `const res = await fetch(${JSON.stringify(url)}, {`,
    `  method: "POST",`,
    `  headers: {`,
    ...headers,
    `  },`,
    `  body: JSON.stringify({`,
    `    model: ${JSON.stringify(slug)},`,
    `    messages: [{ role: "user", content: "Ciao" }],`,
    `  }),`,
    `});`,
    `const data = await res.json();`,
    `console.log(data.choices[0].message.content);`,
  ].join("\n");
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <CopyButton value={code} variant="outline" />
      </div>
      <pre className="overflow-x-auto rounded bg-muted px-3 py-2 text-xs">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface Props {
  slug: string;
  /** Whether a call must carry the agent's key: authentication on, or context fields mapped. Saved values. */
  keyRequired: boolean;
  /** Authentication is off (saved): anyone who reaches the address can talk to the agent. */
  authOff: boolean;
}

/**
 * What a person needs to put the agent on their own site: the address to call,
 * which header to send, and an example to paste. Shown only once the Web channel
 * is on. The key itself is never printed: the examples read it from an environment
 * variable of the caller's server, and the field above is where the key is set.
 */
export function WebEndpointCard({ slug, keyRequired, authOff }: Props) {
  const { t } = useI18n();
  const { data, error } = useResource(["web-endpoint", slug], () => api.channels.webEndpoint(slug));

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="web-endpoint">
      <div>
        <Label className="text-base font-medium">{t("channels.tab.webEndpointTitle")}</Label>
        <p className="text-sm text-muted-foreground">{t("channels.tab.webEndpointHelp")}</p>
      </div>

      {authOff && (
        <p role="alert" className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("channels.tab.webEndpointOpenWarning")}
        </p>
      )}

      {error ? (
        <p className="text-sm text-destructive">{t("channels.tab.webEndpointLoadFailed")}</p>
      ) : data ? (
        <>
          {!data.baseUrlConfigured && (
            <p className="text-sm text-muted-foreground">{t("channels.tab.webEndpointNoBaseUrl")}</p>
          )}
          <div className="space-y-1">
            <Label>{t("channels.tab.webEndpointUrl")}</Label>
            <div className="flex items-center gap-2">
              <code className="block flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{data.endpointUrl}</code>
              <CopyButton value={data.endpointUrl} variant="outline" />
            </div>
            {!data.baseUrlConfigured && (
              <p className="text-xs text-muted-foreground">{t("channels.tab.webEndpointLocalAddress")}</p>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {keyRequired
              ? t("channels.tab.webEndpointHeaderKey")
              : t("channels.tab.webEndpointHeaderNone")}
          </p>
          {keyRequired && <p className="text-sm text-muted-foreground">{t("channels.tab.webEndpointKeyNeverInPage")}</p>}
          <Snippet label={t("channels.tab.webEndpointCurl")} code={buildCurlExample(data.endpointUrl, slug, keyRequired)} />
          <Snippet label={t("channels.tab.webEndpointFetch")} code={buildFetchExample(data.endpointUrl, slug, keyRequired)} />
        </>
      ) : null}
    </section>
  );
}
