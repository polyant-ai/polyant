# Plugin System — Serialized Tool Contract

How Polyant loads agent **tools** from independent plugin repos, and how the
engine's own core tools are authored, using one shared contract:
`@polyant-ai/plugin-sdk`.

## Why

Polyant is a **framework-first**, domain-agnostic engine. Domain-specific tools
(a dental CRM's booking flow, an energy CRM's bill check) must NOT live in the
engine. A plugin is an **external git repo** of tools the engine loads, so the
engine stays generic and each deployment composes the tools it needs.

## The contract in one paragraph

A tool file **default-exports** `defineTool({ name, description, parameters, execute })`.
`parameters` is a **static** Zod schema; `defineTool` (in the SDK) serializes it
to **JSON Schema at module load, in the plugin's own realm**. The engine's loader
collects the default export and stores `{ …metadata, inputSchema, execute }` in
its registry. So the only things that cross the tool↔engine boundary are **data**
(a JSON Schema) and a **function** (`execute(input, ctx)`) — never a live Zod
object or a shared stateful singleton. That data boundary is the whole design:
it lets the engine and every plugin resolve their **own** copies of the SDK (and
`zod`, `ai`, …) without breakage — which is what makes out-of-tree dev and
build-time bake-in possible.

## Components

| Unit | Where | Role |
|------|-------|------|
| `@polyant-ai/plugin-sdk` | repo `github.com/polyant-ai/polyant-sdk` | Stateless contract: `defineTool` + types. Consumed as a **public git dependency** by the engine and by every plugin. Ships built (`dist`). |
| Loader | `agents/tools/registry.ts` → `loadAllTools()` | Scans the core tools dir + N plugin roots, imports each `*.tool.ts`, collects `export default`, applies the plugin namespace, owns the registry Map. |
| Discovery | `plugin-system/plugin-roots.ts` + `plugin-manifest.ts` | Resolves plugin roots (`PLUGIN_DIRS` ∪ `src/plugins/*`), reads/validates `plugin.json`, checks the engine version range. |
| `buildTool()` | `registry.ts` | Turns a registered definition into an AI-SDK `Tool`. Serialized path feeds `ai.jsonSchema(inputSchema)` with a recursive missing-key fill (the strict-mode-safe analogue of the old Zod preprocess). |

## Authoring a tool (core or plugin — identical)

```ts
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "webSearch",
  description: "…",
  category: "research",
  requiredSecrets: ["tavily_api_key"],
  parameters: z.object({                     // STATIC — must not read ctx
    query: z.string(),
    maxResults: z.number().nullable(),
  }),
  execute: async ({ query, maxResults }, ctx) => {
    const key = ctx.secrets?.tavily_api_key;  // ctx: secrets, audit, state, apiKeys, instanceId…
    // … return a plain result …
  },
});
```

### Declaring parameters people can understand

Every key in `requiredSecrets` is a field someone fills in the agent's Tools
section, in the panel of the tool that asks for it. Declare it as a spec with a
`label` and a `description` rather than a bare string:

```ts
requiredSecrets: [
  { key: "tavily_api_key", type: "text", label: "Tavily API key",
    description: "Key of the Tavily account the searches are billed to." },
],
```

Both are optional, so a bare string keeps working: the panel then shows the key
humanized as the title and says the author gave no description. Several tools of
one plugin may declare the same key; the field is shown once and names every tool
that asks for it.

`ctx.artifacts` is an in-process, one-shot handoff between tools in the same
conversation. Each artifact is limited to 10 MB and at most 10 minutes; the
process store accepts at most 100 MB or 1,000 live handles. Persist anything
longer-lived through `fileUpload` instead.

### Schema rules (OpenAI strict-mode compatible — enforced by `strict-mode.test.ts`)
- `.nullable()`, **not** `.optional()` / `.default()` (apply defaults in `execute`).
- No `.transform()` / `.refine()` / `.preprocess()` in `parameters` — move that logic to `execute` and return `{ error }` instead of throwing (see `hubspot-contact.tool.ts`, `http-request.tool.ts`).
- No `.url()`/`.email()`/`.uuid()`/`.datetime()` formats — validate strings in `execute`.
- `z.record(z.string(), z.string())` OK; `z.record(z.unknown())` not.

## `plugin.json` (plugin repo root)

```json
{
  "name": "acme-tools", "version": "1.0.0", "engine": ">=0.1.0", "toolsDir": "tools", "namespace": "acme",
  "displayName": "Acme", "description": "Order status and returns from the Acme back office."
}
```

`namespace` prefixes every tool name → `acme:checkStatus`. Defaults to
`name`. `displayName` and `description` are optional and only change how the
admin panel presents the plugin: its name in the Origin column and in the tool
picker, and its sentence when the picker is browsed by plugin. Without them the
panel humanizes the namespace. Tools are still enabled one by one; the plugin
is never switched as a whole. A plugin whose `engine` range excludes the running engine version is
skipped with a warning (the deployment continues). Duplicate final names fail the
boot loudly.

### `oauthProviders` (optional) — plugin-contributed OAuth providers

A plugin that ships OAuth tools declares the providers they need under
`oauthProviders`; the engine registers them into its OAuth broker at boot, so no
engine change is needed to add a provider.

```json
{
  "name": "acme-tools", "version": "1.0.0", "engine": ">=0.1.0",
  "oauthProviders": [
    {
      "name": "notion",
      "authorizeUrl": "https://api.notion.com/v1/oauth/authorize",
      "tokenUrl": "https://api.notion.com/v1/oauth/token",
      "scope": "",
      "extraAuthorizeParams": { "owner": "user" },
      "pkce": true
    }
  ]
}
```

A tool then references the provider by name via `ctx.oauth.requireToken("notion")`
and declares its per-instance client credentials with
`oauthRequiredSecrets("notion")` (secrets `notion_oauth_client_id` /
`notion_oauth_client_secret`). `name` is a flat, global key (it flows into the
secret keys, the token vault, and the `/oauth/<name>/callback` route), so it is
not namespaced. Two plugins may declare the same provider only if the definitions
are identical; a same-name divergent definition fails the boot — use distinct
names (e.g. `google-gmail`) for divergent scopes. The `OAuthProviderSpec` type is
exported from the SDK as optional typing for manifests.

### `system` (optional) — what the plugin needs from the image

A plugin that shells out to a binary, links against a system library, or needs an
environment variable pointing at one declares it in the manifest:

```json
{
  "name": "acme-tools", "version": "1.0.0", "engine": ">=0.1.0",
  "system": {
    "apk": ["chromium", "nss"],
    "npmGlobal": [],
    "env": { "PUPPETEER_EXECUTABLE_PATH": "/usr/bin/chromium-browser" }
  }
}
```

This is read at BUILD time, not at runtime: the engine cannot install anything
into a running container, and a plugin whose binary is missing must fail on the
tool call rather than refuse to boot and take every other tool down with it.

`Dockerfile.engine` collects the blocks of every plugin in the build and installs
the union in the runtime stage; the entrypoint sources the collected env, because
the variable *names* are not known when the Dockerfile is written. The same env
also applies to the plugin's own build step, or an `npm install` would fetch a
private copy of a binary the image already provides. The engine installs no tool
binaries of its own, so an image built without a plugin does not carry what that
plugin needs.

Two plugins declaring the same variable with different values fail the build
rather than letting one win silently. Package names must be plain enough to
survive an argument list; beyond that there is no allowlist — including a plugin
in a build is already the decision to trust it.

## Loading a plugin — dev

The loader resolves roots from two sources (env wins de-dup):
1. `PLUGIN_DIRS` — comma-separated absolute paths (env, `config.plugins.dirs`).
2. Convention dir — every subdir of `packages/engine/src/plugins/*` with a `plugin.json` (gitignored — see `packages/engine/.gitignore`).

**Module-resolution constraint (important):** `tsx`/Node resolve a file's imports
from the file's **real on-disk location**. So a plugin file must be able to
resolve its deps (`@polyant-ai/plugin-sdk`, `zod`, `ai`, …) by walking up from
where it lives. Two working setups:

- **Out-of-tree (point at your repo):** the plugin repo has its **own**
  `node_modules` (`npm install` there, with the SDK as a git dep). Then
  `PLUGIN_DIRS=/abs/path/to/plugin npm run dev` loads it. No hot-reload for files
  outside the engine tree → restart after edits.
- **In-tree copy/clone:** put the plugin as a **real dir** under
  `packages/engine/src/plugins/<name>` (it resolves the monorepo's `node_modules`);
  `tsx watch` hot-reloads. Do **not** symlink — `tsx` resolves the symlink's
  realpath (the external repo) and fails to find the monorepo deps.

## Loading a plugin — build-time

Drop each plugin into `packages/engine/src/plugins/<name>` (gitignored) before
building the image. The `plugins` stage of `Dockerfile.engine` installs each
plugin's own dependencies, compiles its TypeScript in place and copies the result
to `dist/plugins/<name>`, where the loader scans it at boot; the plugin keeps its
own `node_modules`, so its imports resolve by walk-up rather than from the
engine's tree. The same stage collects the `system` blocks described above.

## The SDK as a git dependency

Both the engine and every plugin reference the SDK by pinned tag:
```
"@polyant-ai/plugin-sdk": "git+https://github.com/polyant-ai/polyant-sdk.git#v1.0.0"
```
`npm install` clones it and runs its `prepare` (build) → `dist`. The SDK's version
is the compatibility contract; bump it deliberately and update the ref.

## Converting a legacy tool to the serialized contract

`registerTool({ create: (ctx) => ({ parameters, execute }) })` →
`export default defineTool({ parameters, execute: (input, ctx) })`:
1. Import `defineTool` from `@polyant-ai/plugin-sdk` (drop `registerTool`).
2. Hoist `parameters` out of `create` to a top-level property.
3. Drop the `create` wrapper; `execute` gains `ctx` as its 2nd parameter.
4. Move any live-schema logic (`.transform`/`.preprocess`) into `execute`.
5. In the tool's test: side-effect import → default import; `requiredSecrets`
   assertions become the normalized specs; ex-`inputSchema.parse` tests call
   `execute` directly.

**Legacy path status:** the `registerTool` / `create`-factory shape **no longer
loads**. `importRoot` (`registry.ts`) recognizes only a default export carrying
`inputSchema` — the `defineTool` shape — and skips anything else with a
`console.warn`. A tool left on the old shape is absent from the registry, from the
`tools` table and from the panel, with a boot-log warning as the only symptom: no
build error, no failing test. There is no compatibility path left; convert it with
the steps above.

## Reference
- SDK repo + authoring guide: `github.com/polyant-ai/polyant-sdk` (its `README.md`).
- Authoring skill: `.claude/skills/plugin-authoring/SKILL.md`.
