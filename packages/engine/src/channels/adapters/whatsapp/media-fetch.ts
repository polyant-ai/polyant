// SPDX-License-Identifier: AGPL-3.0-or-later

import { createSafeDispatcher } from "../../../utils/safe-http.js";

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

/**
 * Iniettabili SOLO per testabilità (default params): in produzione usa `fetch` globale,
 * `createSafeDispatcher` e un timeout reale.
 */
export interface MediaFetchDeps {
  fetchFn?: typeof fetch;
  makeDispatcher?: (url: URL) => Promise<{ dispatcher: unknown }>;
  signal?: AbortSignal;
}

/**
 * Scarica una media Twilio seguendo i redirect **manualmente**, mantenendo la protezione
 * SSRF su OGNI hop: ciascun URL viene ri-validato e il DNS ri-pinnato con
 * `createSafeDispatcher`. Necessario perché le URL `api.twilio.com/.../Media/…` fanno un
 * 302 verso un host diverso (CDN/S3): un dispatcher pinnato al solo host iniziale non
 * seguirebbe il redirect cross-host (si connetterebbe all'IP sbagliato → fetch fallito).
 *
 * L'header `Authorization` Basic è inviato SOLO all'host originale e droppato al cambio
 * host: l'URL del redirect è già firmato e inoltrare le credenziali Twilio a un CDN/S3
 * sarebbe un leak.
 *
 * Ritorna la Response finale, oppure null se un hop fallisce il check SSRF, l'URL non è
 * valido, o si supera il numero massimo di redirect.
 */
export async function fetchMediaFollowingRedirects(
  rawUrl: string,
  basicAuth: string,
  deps: MediaFetchDeps = {},
): Promise<Response | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const makeDispatcher = deps.makeDispatcher ?? createSafeDispatcher;
  const signal = deps.signal ?? AbortSignal.timeout(TIMEOUT_MS);

  let currentUrl = rawUrl;
  let originHost: string | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target: URL;
    try {
      target = new URL(currentUrl);
    } catch {
      console.warn("[whatsapp] Media URL is not a valid URL, skipping: %s", currentUrl);
      return null;
    }
    if (originHost === null) originHost = target.host;

    let dispatcher: unknown;
    try {
      ({ dispatcher } = await makeDispatcher(target));
    } catch (err) {
      console.warn(
        "[whatsapp] Media URL failed SSRF check, skipping (%s): %s",
        currentUrl,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }

    // Auth solo verso l'host originale (Twilio). Droppata al cambio host.
    const headers: Record<string, string> =
      target.host === originHost ? { Authorization: `Basic ${basicAuth}` } : {};

    const res = await fetchFn(target.toString(), {
      headers,
      redirect: "manual",
      signal,
      // @ts-expect-error -- Node 22 fetch supports the undici dispatcher option
      dispatcher,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res; // 3xx senza Location: lascia decidere al chiamante (res.ok = false)
      currentUrl = new URL(location, target).toString();
      continue;
    }
    return res;
  }

  console.warn("[whatsapp] Media download exceeded %d redirects, skipping: %s", MAX_REDIRECTS, rawUrl);
  return null;
}
