// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every page of the panel, discovered from the app router, for the suites
 * that visit them all (accessibility, screenshots).
 *
 * A route is a `page.tsx` under `src/app`; its dynamic segments are filled
 * from the panel seed (seed-panel.ts). The agent page is one route with a
 * section per `?tab=`, so each registered section is a page of its own here.
 *
 * Discovery is the point: a page added to the panel joins the suites without
 * anyone remembering to list it. The only hand-kept lists are the exceptions,
 * and each one says why:
 *
 * - REDIRECTS: routes that send the browser elsewhere. They are visited to
 *   check that they still land where they say, and the destination is what
 *   the suites scan.
 * - SKIPPED: routes that render nothing a person reads (a catch-all, a page
 *   that signs out).
 * - A dynamic segment with no value in PARAMS fails catalog.spec.ts, naming
 *   the segment, instead of being dropped.
 *
 * A build with more pages (more groups, more agent sections) declares their
 * exceptions in `page-catalog.extra.ts` next to this file, which this module
 * reads when it exists.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AGENT_SECTIONS } from "../../src/lib/nav/agent-sections";
import {
  PANEL_AGENT_SLUG,
  PANEL_CONVERSATION_ID,
  PANEL_ORG_SLUG,
  PANEL_WORKSPACE_SLUG,
  WEB_PACKAGE_ROOT,
} from "../setup/test-env";

export interface CatalogPage {
  /** The URL path (with query) the suite opens. */
  readonly path: string;
  /** The `page.tsx` it comes from, relative to `src/app`, for messages. */
  readonly source: string;
  /** Opened without a session (the sign-in pages). */
  readonly anonymous: boolean;
}

export interface CatalogExtension {
  readonly params?: Readonly<Record<string, string>>;
  readonly redirects?: Readonly<Record<string, string>>;
  readonly skipped?: Readonly<Record<string, string>>;
}

/** Values for the dynamic segments, all from the panel seed. */
const PARAMS: Record<string, string> = {
  orgSlug: PANEL_ORG_SLUG,
  workspaceSlug: PANEL_WORKSPACE_SLUG,
  slug: PANEL_AGENT_SLUG,
  conversationId: encodeURIComponent(PANEL_CONVERSATION_ID),
  // A skill page redirects to the skills list with the skill selected, so
  // any name exercises it.
  name: "e2e-skill",
};

const ORG = `/organizations/${PANEL_ORG_SLUG}`;
const WS = `${ORG}/workspaces/${PANEL_WORKSPACE_SLUG}`;

/**
 * Route → where it lands (path and query). Keyed by the filled-in route. The
 * destination is compared exactly, so a redirect that changes target fails
 * catalog.spec.ts until this list says the new one.
 */
const REDIRECTS: Record<string, string> = {
  "/": ORG,
  "/skills/e2e-skill": "/skills?skill=e2e-skill",
  [`${ORG}/audit-logs`]: `${WS}/monitor?group=agents&type=tool_call`,
  [WS]: `${WS}/instances`,
  [`${WS}/activity`]: `${WS}/monitor`,
  // Only someone who must change their password stays here.
  "/password-change": ORG,
};

/** Route → why it is not visited. */
const SKIPPED: Record<string, string> = {};

function loadExtension(): CatalogExtension {
  const path = join(__dirname, "page-catalog.extra.ts");
  if (!existsSync(path)) return {};
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require(path) as { extension: CatalogExtension }).extension;
}

const extension = loadExtension();
const params = { ...PARAMS, ...extension.params };
const redirects = { ...REDIRECTS, ...extension.redirects };
const skipped = { ...SKIPPED, ...extension.skipped };

const APP_DIR = join(WEB_PACKAGE_ROOT, "src", "app");

function findPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findPages(full));
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

export interface DiscoveredRoute {
  /** `src/app`-relative file, e.g. `(admin)/about/page.tsx`. */
  readonly source: string;
  /** Route segments with groups removed, e.g. `/organizations/[orgSlug]`. */
  readonly pattern: string;
  /** Filled-in path, or null when a segment has no value. */
  readonly path: string | null;
  /** The segments PARAMS has no value for. */
  readonly missing: readonly string[];
  readonly group: string | null;
}

export function discoverRoutes(): DiscoveredRoute[] {
  return findPages(APP_DIR)
    .map((file) => {
      const source = relative(APP_DIR, file).split(sep).join("/");
      const segments = source.split("/").slice(0, -1);
      const group = segments.find((s) => /^\(.+\)$/.test(s)) ?? null;
      const routeSegments = segments.filter((s) => !/^\(.+\)$/.test(s));
      const pattern = "/" + routeSegments.join("/");
      const missing: string[] = [];
      const filled = routeSegments.map((s) => {
        const dynamic = /^\[(\.\.\.)?([^\]]+)\]$/.exec(s);
        if (!dynamic) return s;
        if (dynamic[1]) {
          missing.push(s);
          return s;
        }
        const value = params[dynamic[2]];
        if (value === undefined) missing.push(s);
        return value ?? s;
      });
      return {
        source,
        pattern,
        path: missing.length ? null : "/" + filled.join("/"),
        missing,
        group,
      };
    })
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
}

export function catalogRedirects(): Readonly<Record<string, string>> {
  return redirects;
}

export function catalogSkipped(): Readonly<Record<string, string>> {
  return skipped;
}

/** The section values the agent page accepts as `?tab=`. */
export function agentTabs(): string[] {
  return AGENT_SECTIONS.map((s) => s.tab);
}

/**
 * The pages the suites scan: every discovered route that is neither a
 * redirect nor skipped nor missing a value, plus one entry per agent section.
 * A redirect's destination is scanned as the page it lands on, when that page
 * is itself a route.
 */
export function catalogPages(): CatalogPage[] {
  const pages: CatalogPage[] = [];
  const agentPath = `${WS}/instances/${PANEL_AGENT_SLUG}`;
  for (const route of discoverRoutes()) {
    if (!route.path || route.path in redirects || route.pattern in skipped || route.path in skipped) continue;
    if (route.path === agentPath) {
      for (const tab of agentTabs()) {
        pages.push({ path: `${agentPath}?tab=${tab}`, source: `${route.source}?tab=${tab}`, anonymous: false });
      }
      continue;
    }
    pages.push({ path: route.path, source: route.source, anonymous: route.group === "(auth)" });
  }
  return pages;
}
