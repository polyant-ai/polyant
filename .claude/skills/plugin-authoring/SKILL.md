---
name: plugin-authoring
description: Use when creating or changing Polyant tools, lifecycle hooks, plugin manifests, plugin discovery, or the public plugin contract.
---

# Plugin authoring

`docs/plugins.md` is the public contract. The SDK types and loader tests are executable truth.
Read both before changing a definition or manifest.

## Built-in definitions

- Put a tool in `packages/engine/src/agents/tools/<name>.tool.ts` and default-export
  `defineTool(...)` from `@polyant-ai/plugin-sdk`.
- Put a hook in `packages/engine/src/hooks/<name>.hook.ts` and default-export
  `defineHook(...)`.
- Keep definition schemas static. Runtime secrets, instance data, state, and workspace paths
  come from the execution context.
- Treat `replyHandled` and `replyText` as reserved tool-result fields.
- Copy the closest current definition and its tests; do not use legacy registration shapes
  found in Git history or old external plugins.

## External plugins

Inspect `packages/engine/src/plugin-system/`, the current SDK dependency in the engine
manifest, and the manifest schema before editing `plugin.json`. Do not copy version numbers
into this skill. Use a real plugin directory with its own dependencies; verify discovery
from the same filesystem layout used at runtime.

Plugin and hook retries can repeat side effects. Make operations idempotent where the host
can replay them, and document a deliberate non-idempotent effect at its call boundary.

## Verify

Run the definition's focused test plus the registry/strict-mode or plugin-system tests it
crosses, then:

```bash
npm run typecheck -w @polyant/engine
npm run lint -w @polyant/engine
```

For public contract changes, update `docs/plugins.md` in the same change and test an actual
load path. Report any check that could not run.
