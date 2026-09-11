---
name: backend-architecture
description: Use when changing backend behaviour, storage, HTTP endpoints, the message pipeline, providers, channels, tools, or hooks under packages/engine.
---

# Backend architecture

Keep changes inside the existing boundary that owns the behaviour. The code, schema,
migrations, and tests are authoritative; this skill is a workflow, not a copied catalogue.

## Before editing

1. Read `CLAUDE.md` and `.claude/rules/engine.md`; read the migration rule for schema work.
2. Trace the request from its boundary through every caller to the store or pipeline stage.
3. Inspect the local tests and recent history of the target files.
4. For public tool, hook, or plugin contracts, also read `docs/plugins.md` and the
   `plugin-authoring` skill.

## Boundaries to preserve

- NestJS lives in `src/server/` and adapts HTTP to domain functions. Do not move domain
  logic or request objects across that boundary.
- Agent configuration is database data accessed through its owning store/resolver.
- LLM calls cross the AI-gateway provider boundary; callers request a tier/capability.
- Slugs and UUIDs are distinct branded identifiers. Tenant predicates fail closed.
- Post-response stages remain asynchronous and commit only after their gate succeeds.
- Tools and hooks use the SDK definitions discovered by the registry at boot.

Follow the pattern in the nearest working sibling instead of applying generic architecture
templates. Do not add barrels, services, factories, or repository layers without an existing
need demonstrated by multiple callers.

## Verify

Run the smallest test that exercises the changed behaviour, then:

```bash
npm run typecheck -w @polyant/engine
npm run lint -w @polyant/engine
```

Run broader unit or integration suites only when the touched boundary warrants them. Schema
changes also require the migration-journal guardrail. Report any check that could not run.
