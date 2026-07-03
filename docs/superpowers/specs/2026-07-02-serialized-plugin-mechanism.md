# Serialized Plugin Mechanism — Design Record

**Date:** 2026-07-02
**Status:** Implemented (`feat/tool-serialized-plugins`)
**Scope:** `@polyant-ai/plugin-sdk` (new repo), engine tool registry + loader, per-tool contract.

## Problem

Agent tools were compiled into the engine. Domain tools (dental, energy CRM…)
had no home outside it, tensioning the framework-first rule. We need tools to
live in **independent plugin repos**, loadable in dev (point at a folder) and at
build-time (bake per deployment), without the engine shipping domain logic.

## The core obstacle we hit (and the decision)

A first design put the tool **registry (a `Map`) inside the SDK**, with tools
self-registering via `registerTool` as an import side-effect. This forces every
plugin to resolve the **exact same SDK module instance** as the engine — else a
different `Map` → the plugin's tools are invisible. Two hard findings made this
untenable for real plugins:

1. **Module resolution (empirically verified):** `tsx`/Node resolve a file's bare
   specifiers from the file's **realpath**. An out-of-tree plugin file (or a
   symlinked one — `--preserve-symlinks` did not help) cannot resolve the
   monorepo's deps; it needs its own `node_modules`. But then it resolves its
   **own** SDK copy → singleton broken.
2. **Dual-package hazard:** even with a shared SDK, passing a live `ZodObject`
   across the boundary breaks the engine's `parameters instanceof z.ZodObject`
   when the plugin has its own `zod` copy.

**Decision — a serialized-data boundary + a stateless SDK:**
- The **engine loader owns the registry**; the SDK holds no state.
- Tools **default-export** `defineTool(...)`; `defineTool` converts the static Zod
  `parameters` → **JSON Schema at load, in the plugin's realm**.
- Only **data** (`inputSchema`) + a **function** (`execute(input, ctx)`) cross the
  boundary. Nothing requires shared identity.

Consequence: engine and each plugin may resolve their **own** copies of the SDK,
`zod`, `ai`, etc. — harmless. This is precisely what unlocks out-of-tree dev and
build-time bake-in. (Verified end-to-end: a plugin loads from an external folder
via `PLUGIN_DIRS`, with the SDK resolved as a git dependency.)

## Alternatives considered
- **Keep the SDK singleton, force same-instance resolution** — rejected: brittle
  (no own deps, no bundling, symlink landmines).
- **Publish the SDK from the monorepo (package stays in `packages/`)** — viable;
  rejected in favor of a dedicated repo because the SDK must evolve as an
  independent, versioned contract consumed by external plugin authors.
- **Path alias / vendoring engine internals into plugins** — rejected: leaks
  internals, breaks a plugin's standalone build.

## Shape of the solution
- `@polyant-ai/plugin-sdk` — own repo (`github.com/polyant-ai/polyant-sdk`), built
  to `dist` (`prepare` step) so it is consumable as a **public git dependency**
  (`git+https://github.com/polyant-ai/polyant-sdk.git#v1.0.0`) by both the engine
  and plugins. Versioned = the compatibility contract.
- Loader: `loadAllTools()` scans core tools + plugin roots (`PLUGIN_DIRS` ∪
  `src/plugins/*`), namespaces per plugin, checks the `engine` semver range.
- `buildTool()` dispatches serialized vs legacy; the serialized path fills missing
  nullable keys recursively inside `ai.jsonSchema()` validation (the strict-mode
  analogue of the legacy Zod `preprocess`).
- **Backward compatible:** `registerTool`/`create` still work (the loader +
  `buildTool` dispatch on the presence of `inputSchema`), so the core tools were
  migrated incrementally with the engine green at every step.

## Migration analysis (why it was low-risk)
Every tool inspected across the catalog had **static** parameter schemas (none
built from `ctx`) and **no** `.transform/.refine/.superRefine/.discriminatedUnion/
.default` in parameters. Only two carried live-schema logic that moved into
`execute`: `hubspotContact` (filters preprocess+transform) and `http-request`
(authStyle preprocess). Everything else was mechanical.

## Deferred
- Build-time bake-in (CDK/Docker clone or bundle of pinned plugins).
- Removing the legacy `registerTool` path once every tool is migrated.
- Publishing the SDK to a registry (GitHub Packages) instead of git deps, if
  external cadence demands it.
