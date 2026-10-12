// SPDX-License-Identifier: AGPL-3.0-or-later

import { cookies, headers } from "next/headers";
import { resolveLocale } from "./resolve";
import { LOCALE_COOKIE, type Locale } from "./types";

/** The locale for the current request. Reading cookies and headers makes the caller dynamic. */
export async function getServerLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
}
