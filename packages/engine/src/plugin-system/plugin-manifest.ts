// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse, satisfies, validRange } from "semver";
import { z } from "zod";

/**
 * Shape of one entry in a plugin manifest's `oauthProviders` array. A plugin
 * contributes OAuth providers to the engine's broker registry by declaring them
 * in `plugin.json`; the engine validates + registers them at boot. Structurally
 * matches `OAuthProvider` in server/oauth/oauth-providers.ts (and the SDK's
 * exported `OAuthProviderSpec`) — the compiler enforces the match at the
 * `registerOAuthProvider()` call site in the tool loader.
 */
export const oauthProviderManifestSchema = z.object({
  name: z.string().min(1),
  authorizeUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  scope: z.string(),
  extraAuthorizeParams: z.record(z.string(), z.string()).default({}),
  pkce: z.boolean().default(false),
});

/**
 * What a plugin needs from the RUNTIME IMAGE, not from npm: distro packages it
 * shells out to or links against, npm packages that must be on PATH as
 * executables, and environment variables that point at them.
 *
 * Read at BUILD time by `Dockerfile.engine`, never at runtime — the engine has
 * no way to install anything into a running container, and a plugin that finds
 * its binary missing must fail on the call, not at boot. Declaring this is the
 * only way the image can stop carrying Chromium for a PDF tool no deployment
 * enables.
 *
 * Including a plugin in a build means trusting it: these values become
 * `apk add` and `npm i -g` arguments in the image. There is no allowlist, by
 * decision — the trust boundary is the choice to include the plugin at all.
 */
export const pluginSystemRequirementsSchema = z.object({
  /** Alpine packages installed into the runtime stage. */
  apk: z.array(z.string().min(1)).default([]),
  /** npm packages installed globally, for the executables they put on PATH. */
  npmGlobal: z.array(z.string().min(1)).default([]),
  /** Environment variables baked into the runtime image. */
  env: z.record(z.string(), z.string()).default({}),
});

export type PluginSystemRequirements = z.infer<typeof pluginSystemRequirementsSchema>;

/**
 * A plugin repo declares a `plugin.json` at its root. This is the discovery
 * contract: `name` + `namespace` decide the tool-name prefix, `engine` gates
 * compatibility, `toolsDir` says where the `*.tool.ts` files live.
 */
export const pluginManifestSchema = z.object({
  /** Stable plugin id (also the conventional install dir name). */
  name: z.string().min(1),
  /** Plugin version (independent of the engine version). */
  version: z.string().min(1),
  /** Engine compatibility range (semver range, e.g. ">=0.1.0"). */
  engine: z.string().min(1),
  /** Directory (relative to the plugin root) scanned for *.tool.ts. Defaults to "tools". */
  toolsDir: z.string().min(1).default("tools"),
  /** Directory (relative to the plugin root) scanned for *.hook.ts. Defaults to "hooks". */
  hooksDir: z.string().min(1).default("hooks"),
  /** Tool-name prefix applied to every tool in this plugin. Defaults to `name`.
   * Empty string is rejected — there is no "unprefixed plugin" option. */
  namespace: z.string().min(1).optional(),
  /** OAuth providers this plugin contributes to the engine's broker registry. */
  oauthProviders: z.array(oauthProviderManifestSchema).default([]),
  /** What the runtime image must carry for this plugin's tools to work. */
  system: pluginSystemRequirementsSchema.default({ apk: [], npmGlobal: [], env: {} }),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema> & { namespace: string };

/**
 * Read + validate `<root>/plugin.json`. Returns null (not throws) when the file
 * is absent or invalid — a non-plugin directory is silently skipped by the
 * resolver, but a malformed manifest is logged so a typo is diagnosable.
 */
export function readPluginManifest(root: string): PluginManifest | null {
  const file = join(root, "plugin.json");
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`Plugin manifest at ${file} is not valid JSON — skipping: ${(err as Error).message}`);
    return null;
  }
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`Plugin manifest at ${file} failed validation — skipping: ${parsed.error.message}`);
    return null;
  }
  // Namespace defaults to name; guaranteed non-empty by the schema when present.
  return { ...parsed.data, namespace: parsed.data.namespace ?? parsed.data.name };
}

/**
 * True when `engineVersion` satisfies the plugin's declared `engine` range.
 * Fail-closed: an unparseable range or version returns false (skip the plugin)
 * rather than wrongly loading an incompatible one.
 *
 * The comparison uses only MAJOR.MINOR.PATCH, deliberately. A prerelease tag is
 * excluded from a semver range that carries none — `1.1.0-beta.1` satisfies
 * neither `>=0.1.0` nor `^1.1.0` — so the moment this package ships a version
 * with any suffix, EVERY third-party plugin fails this gate and is skipped with
 * a `console.warn`. Boot still succeeds and the deploy still goes green; the
 * agent simply has no plugin tools or hooks. A build marker is not a
 * compatibility statement, and the version numbers already are one.
 */
export function engineSatisfies(manifest: PluginManifest, engineVersion: string): boolean {
  if (!validRange(manifest.engine)) return false;
  const parsed = parse(engineVersion);
  if (!parsed) return false;
  return satisfies(`${parsed.major}.${parsed.minor}.${parsed.patch}`, manifest.engine);
}
