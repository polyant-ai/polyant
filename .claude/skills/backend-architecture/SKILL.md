---
name: backend-architecture
description: Use when building, modifying, or adding any backend feature in packages/engine. Use when creating tools, adding API endpoints, modifying the AI pipeline, adding channel adapters, working with database schemas, or touching the message pipeline.
---

# Backend Architecture & Patterns

## Overview

Hybrid architecture: **functional pipeline** for AI runtime + **NestJS** as HTTP bridge only. Vercel AI SDK v6 for LLM orchestration, Drizzle ORM + pgvector for persistence, Zod for validation.

**Core principle:** Pipeline is functional with module-level singletons. NestJS DI is confined to `server/`. Never introduce DI or decorators outside the `server/` directory.

## Module Organization

Domain-oriented with co-located files per module:

| File | Purpose |
|------|---------|
| `schema.ts` | Drizzle ORM table definition |
| `store.ts` | CRUD / data access (pure functions or singleton class) |
| `types.ts` | TypeScript interfaces and type aliases |
| `index.ts` | Barrel re-exports (public API) |

Schemas live in their domain (`memory/schema.ts`, `conversations/schema.ts`, `instances/schema.ts`), not in a central `database/` folder. Exception: `ai_logs` table is defined inline in `ai-gateway/logger.ts` (co-located with its only consumer).

## Quick Reference: Naming & Exports

| Convention | Rule |
|------------|------|
| Files | `kebab-case.ts` always |
| Tools | `*.tool.ts` (auto-discovered) |
| Tests | `*.test.ts` co-located with source |
| Adapters | `adapters/<channel>/index.ts` |
| Exports | **Named only** — never `export default` |
| Types | `interface` for data shapes, `type` for unions/aliases |
| Constants | `UPPER_SNAKE_CASE` for module-level |
| Singletons | Named constant: `export const conversationStore = new ConversationStore()` |
| Imports | `.js` extension on every relative import (ESM) |

## AI Gateway (Tier Abstraction)

Request LLM by **tier**, never by model name:

```typescript
// Correct
await chat({ tier: "fast", messages, system });

// Wrong — never hardcode models
await chat({ model: "gpt-4o-mini", messages, system });
```

| Tier | Use Case |
|------|----------|
| `fast` | Summaries, memory extraction, tool-assisted edits |
| `standard` | Supervisor main loop, sub-agents |
| `heavy` | Complex reasoning (reserved) |

**Provider adapters**: Factory pattern via `createProvider(name, modelFactory)` in `ai-gateway/providers/base.ts`. Concrete providers are one-liners passing the AI SDK's factory.

**Per-instance overrides**: `ChatRequest` accepts optional `provider`/`model` fields that bypass tier resolution.

**Embeddings always use OpenAI** (`@ai-sdk/openai`) — the per-instance `openai_api_key` secret is required regardless of the instance's AI provider. Anthropic has no embedding API. Model: `text-embedding-3-small` (1536 dims).

## Tool System (Serialized Definitions)

**To add a new tool:**

1. Create `packages/engine/src/agents/tools/<name>.tool.ts`
2. `export default defineTool({ name, description, parameters, execute })` from
   `@polyant-ai/plugin-sdk`. `parameters` is a **static** Zod schema — it must not read
   `ctx`; `defineTool` serializes it to JSON Schema at module load, in the tool's own realm
3. The loader (`loadAllTools()`) collects the default export at boot and syncs the `tools`
   DB table — no manual inserts
4. No other files need modification

The serialized boundary is the point: only DATA (`inputSchema`) and a FUNCTION (`execute`)
cross between a tool and the engine, never a live Zod object or a shared singleton. That is
what lets an external plugin resolve its own copies of the SDK, `zod` and `ai`. The legacy
`registerTool({ create })` shape still loads (the loader dispatches on the presence of
`inputSchema`) but nothing new should use it.

`parameters` must satisfy OpenAI strict mode — see `references/tools-and-hooks.md` for the
banned Zod constructs and the guard-rail test that enforces them.

**Key types:**

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  category?: string;
  requiredEnv?: string[];  // auto-pruned at boot if missing
  create: (ctx: ToolContext) => {
    parameters: z.ZodType;
    execute: (params: any) => Promise<unknown>;
  };
}

interface ToolContext {
  instanceId: string;
  workspace: WorkspacePaths;
  secrets?: Record<string, string>;  // per-instance decrypted secrets (for tools needing API keys)
}
```

**Tool error handling — never throw:**

```typescript
// Correct
execute: async (params) => {
  try {
    // ... work ...
    return { success: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
```

**Zod parameter conventions:**
- `z.string().describe("...")` on every field (LLM reads descriptions)
- `z.type().nullable()` for optional params with defaults (LLM passes `null`, execute applies default)
- Descriptions match the instance's primary language (the LLM reads them at runtime)

**Tool enablement**: Per-instance tool enablement is stored in `instance_tools` DB table. Auto-recomputed when skills change via `recomputeInstanceTools()`.

**`spawnTask` meta-tool**: Created separately via `createTaskTool(tools)` — receives all built tools except itself (prevents recursion). Uses tier `standard`, `maxSteps: 10`.

## Instance Configuration (Database-First)

All instance configuration is stored in PostgreSQL:

- **Prompts**: `instance_prompts` table (8 sections per instance). Read via `getPrompts(instanceId)` with 60s TTL cache. Seeded from `instances/defaults.ts` on instance creation
- **Skills**: `skills` + `skill_versions` (global catalog), `instance_skills` (per-instance). Discovered via DB joins in `supervisor/prompt.ts`
- **Tools**: `tools` (global catalog, synced from registry at boot), `instance_tools` (per-instance, auto-recomputed when skills change)
- **Secrets/Channels**: `instance_secrets` + `instance_channels` (AES-256-GCM encrypted)

The `workspace/` module is used **only** for knowledge file sync:
- `getWorkspacePaths(instanceId)` → returns `{ root, knowledgeDir }`
- No template directory, no prompt/skill/tool filesystem access

## Message Pipeline

Two parallel paths, same enrichment:

```
Request → preEnrich() → resolve instance → load history → supervise/superviseStream
                                                                    ↓
Response → sent to user immediately
                                                                    ↓ (fire-and-forget)
afterResponse() → save messages → update summary → extract memories
```

**Rules:**
- `afterResponse()` must never block the user response
- Post-processing errors are caught and logged, never propagated
- Skip post-processing for automated tasks (`isAutoTask()` checks `### Task:` prefix)
- Conversation summary injected as synthetic user/assistant exchange before history
- Max 15 messages loaded from DB, falls back to client-provided history

## NestJS Integration

NestJS is the **HTTP bridge only** — confined to `server/`:

```
ServerModule
  imports: [OpenAIModule, SkillsModule]
  controllers: [HealthController, MemoriesController, InstancesController, ConversationsController, AnalyticsController]
```

**Handler injection pattern**: Pipeline handlers are closures defined in `index.ts`, injected into `OpenAIService` via setters after NestJS app creation. This decouples the pipeline from DI.

**Controller conventions:**
- Route prefix matches domain: `api/instances`, `api/skills`, `v1`, `health`, `memories`
- Error responses via NestJS exceptions: `NotFoundException`, `ConflictException`, `InternalServerErrorException`
- No global exception filters or interceptors
- CORS enabled with no origin restrictions

## Drizzle ORM Conventions

```typescript
// Table definition pattern
export const tableName = pgTable("table_name", {
  id: uuid("id").primaryKey().defaultRandom(),
  // ... columns ...
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_table_column").on(table.column),
]);
```

- UUID primary keys with `defaultRandom()`
- Timestamps: `defaultNow()` for both `createdAt`/`updatedAt`
- JSONB via `jsonb("col").$type<Type>()` for flexible data
- pgvector: `vector("embedding", { dimensions: 1536 })`
- Indexes in third argument as array
- Raw SQL via `db.execute(sql\`...\`)` for FTS, complex JOINs, aggregations
- Connection: single `postgres()` client, no explicit pool config
- Migration runner is standalone script (separate from app boot)

## Error Handling Patterns

| Context | Pattern |
|---------|---------|
| Config validation | `safeParse()` + `process.exit(1)` |
| Tool registry | Throw on duplicates |
| NestJS controllers | Built-in HTTP exceptions |
| Tool execute | try/catch → `{ success: false, error }` — **never throw** |
| Fire-and-forget | catch + log, never propagate |
| Channel adapters | Silent skip if credentials missing, silent catch on init failure |
| Cost estimation | Return 0 for unknown models (graceful degradation) |
| Memory init | Warn on pgvector missing, don't throw |

## Channel Adapter Pattern

All adapters implement `ChannelAdapter` interface with consistent structure:

1. **Config via constructor**: Adapters receive config via constructor (not from global config)
2. **Library instance**: `private` nullable field (`bot`, `app`, `server`)
3. **`sendMessage()`**: Throws if adapter never initialized (null check)
4. **`shutdown()`**: No-op if never initialized (null guard)
5. **Per-instance lifecycle**: `ChannelManager` manages per-instance channels with `startChannel()`/`stopChannel()`
6. **Error isolation**: Channel manager catches per-adapter failures individually

Adapters live in `channels/adapters/<name>/index.ts`. Class: `<Name>Adapter`.

## Memory & Search

- **Dedup**: Cosine similarity > 0.90 → UPDATE existing, otherwise INSERT new
- **Hybrid search**: RRF (k=60) fuses pgvector semantic results + PostgreSQL FTS keyword results
- **FTS config**: `'simple'` (no language-specific stopwords, multilingual support)
- **FTS function**: `websearch_to_tsquery('simple', query)` with `ts_rank()` scoring
- **Extraction**: Fire-and-forget after each response. LLM tier `fast` extracts JSON facts → batch embed → sequential upsert
- **Categories**: `preference | fact | event | relationship | decision | general`

## ESM Requirements

- `.js` extension on **every** relative import (`import { x } from "./module.js"`)
- `import.meta.url` + `fileURLToPath()` for `__dirname` equivalent
- `import "reflect-metadata"` at top of NestJS entry points
- Dynamic imports for tool loading: `import(join(dir, file))`
- `process.env.WORKSPACES_ROOT` for path override (documented exception to "no direct env access")

## Config Management

All env vars validated via Zod in `config.ts`:

```typescript
const result = configSchema.safeParse({ /* manual env mapping */ });
if (!result.success) {
  console.error("Configuration error:", result.error.format());
  process.exit(1);
}
export const config = loadConfig();
```

**Rules:**
- Never read `process.env` directly (exceptions: `DEFAULT_INSTANCE_ID`, `WORKSPACES_ROOT`)
- `z.coerce.number()` / `z.coerce.boolean()` for string env var conversion
- Config evaluated at import time (module-level side effect)
- New env vars must be added to `config.ts` Zod schema
- AI provider keys, LangSmith, auth, Tavily, and channel config are per-instance (stored in `instance_secrets`/`instance_channels`, resolved via `config-resolver.ts`). Only infrastructure vars remain in `config.ts`

## Common Mistakes

| Mistake | Correct Approach |
|---------|-----------------|
| Using NestJS DI outside `server/` | Use module-level singletons and pure functions |
| Forgetting `.js` in imports | Always add `.js` to relative import paths |
| Reading `process.env` directly | Import from `config.ts` (Zod-validated) |
| Throwing in tool execute | Return `{ success: false, error }` |
| Using `export default` | Always use named exports |
| Hardcoding model names | Use tier abstraction: `fast`, `standard`, `heavy` |
| Blocking user response with post-processing | Fire-and-forget: `afterResponse()` must be non-blocking |
| Creating skills/prompts on filesystem | All config in PostgreSQL — use DB stores and Management API |
| Centralizing schemas in `database/` | Co-locate schema with its domain module |
| Adding connection pool config | Use postgres.js defaults |

## Reference files

Loaded on demand — the reasoning and failure modes behind the rules in `CLAUDE.md`.

| File | Covers |
|---|---|
| `references/ai-gateway.md` | Model catalog, prompt caching, provider adapters, the AI SDK v6 boundary |
| `references/pipeline.md` | Burst coordination, cancellation, conversation state, debug capture, typed SSE |
| `references/instances.md` | Embedder independence, the destructive embedder switch, AWS secret namespaces, export/import |
| `references/channels.md` | Channel adapters, GDPR opt-out |
| `references/tools-and-hooks.md` | Tool registry, lifecycle hooks, plugins, MCP |
| `references/operations.md` | Logging, audit, room, webhooks, scheduling, workspace credentials |
| `references/auth-and-rbac.md` | Why authentication, tenancy and RBAC are shaped the way they are |
| `references/first-party-tools.md` | Behaviour of individual shipped tools |
