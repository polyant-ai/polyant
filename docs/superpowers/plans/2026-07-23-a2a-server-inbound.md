# A2A Server (inbound) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose each Polyant instance as an A2A-compliant agent (Agent Card + `message/send` + `message/stream`) over per-slug JSON-RPC routes, gated by a new per-instance `a2aEnabled` flag and the existing per-instance API key.

**Architecture:** A new NestJS module `server/a2a/` wraps `@a2a-js/sdk`. A per-slug `DefaultRequestHandler` (built lazily, TTL-cached) serves the SDK's Express middlewares from a thin NestJS controller. A `PolyantAgentExecutor` bridges the SDK's `execute(ctx, eventBus)` seam to the existing streaming pipeline (`handleMessageStream`), publishing A2A Task/status/artifact events. Tasks are ephemeral (`InMemoryTaskStore`); the pipeline is synchronous single-turn.

**Tech Stack:** TypeScript (ESM), NestJS 11 on Express, Drizzle ORM (PostgreSQL), Vitest, `@a2a-js/sdk`.

**Spec:** `docs/superpowers/specs/2026-07-23-a2a-server-inbound-design.md`

**Commit convention (repo):** every commit needs a DCO sign-off — use `git commit -s`. Include the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. For multi-line messages use `git commit -F <file>` (this shell mangles multi-line `-m`). Branch is `feat/a2a-server-inbound` (already created). PRs target `develop`, not `main`.

**One deliberate deviation from the spec (ponytail):** the Agent Card's `skills[0].tags` is left `[]` in the MVP instead of being populated from enabled skill slugs. The builder accepts a `tags` argument (default `[]`) so this is a one-line wiring change later, with no code churn. Reason: populating tags needs a slug→uuid resolve + an `instance_skills` join on the hot card path for a discovery nicety. `// ponytail: tags empty in MVP; pass enabled skill slugs into buildAgentCard when discovery matters`

---

## File Structure

**Create:**
- `packages/engine/src/database/migrations/0071_add_a2a_enabled.sql` — add the flag column
- `packages/engine/src/server/a2a/a2a-context.ts` — pure helpers: `extractText`, `contextIdToConversationId`
- `packages/engine/src/server/a2a/agent-card.builder.ts` — pure: instance → `AgentCard`
- `packages/engine/src/server/a2a/polyant-agent.executor.ts` — `createPolyantExecutor` (the bridge)
- `packages/engine/src/server/a2a/a2a-handler.registry.ts` — per-slug `DefaultRequestHandler` cache
- `packages/engine/src/server/a2a/a2a.controller.ts` — thin HTTP bridge
- `packages/engine/src/server/a2a/a2a.module.ts` — NestJS wiring
- Test files alongside each of the four logic units above.

**Modify:**
- `packages/engine/src/instances/schema.ts` — add `a2aEnabled` column
- `packages/engine/src/database/migrations/meta/_journal.json` — register the migration
- `packages/engine/src/instances/config-resolver.ts` — surface the flag (2 sites)
- `packages/engine/src/server/instances/instances.controller.ts` — response DTO + update DTO
- `packages/engine/src/instances/store.ts` — persist the flag on update (mirror `cacheEnabled`)
- `packages/engine/src/instances/export.schema.ts` — add `a2aEnabled` to the export schema
- `packages/engine/src/instances/import.service.ts` — persist `a2aEnabled` on create + overwrite
- `packages/engine/src/server/main.ts` — inject the stream handler into the registry
- `packages/engine/src/server/server.module.ts` — import `A2aModule`
- `packages/web/src/lib/api.ts` — add `a2aEnabled?` to the update payload type
- `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx` — the toggle

---

## Task 1: Add the `@a2a-js/sdk` dependency

**Files:**
- Modify: `packages/engine/package.json` (via npm)

- [ ] **Step 1: Install the SDK into the engine workspace**

Run: `npm install @a2a-js/sdk -w @polyant/engine`

- [ ] **Step 2: Verify it ships ESM + type defs**

Run: `node -e "import('@a2a-js/sdk').then(m => console.log(Object.keys(m).slice(0,10)))"`
Expected: prints exported names (e.g. `AGENT_CARD_PATH`, types) with no ESM/CJS error. Also confirm `packages/engine/node_modules/@a2a-js/sdk` contains a `server/` and `server/express/` subpath and `.d.ts` files.

If the import throws a CJS/ESM interop error, stop and report — the whole plan assumes native ESM. Do not proceed.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/package.json package-lock.json
git commit -s -m "chore(a2a): add @a2a-js/sdk dependency"
```

---

## Task 2: Add the `a2aEnabled` schema column + migration

**Files:**
- Modify: `packages/engine/src/instances/schema.ts` (near line 43, the other boolean flags)
- Create: `packages/engine/src/database/migrations/0071_add_a2a_enabled.sql`
- Modify: `packages/engine/src/database/migrations/meta/_journal.json`

- [ ] **Step 1: Add the column to the Drizzle schema**

In `schema.ts`, alongside the existing flags (after `cacheEnabled: boolean("cache_enabled")...`), add:

```ts
a2aEnabled: boolean("a2a_enabled").notNull().default(false),
```

- [ ] **Step 2: Write the migration SQL**

Create `packages/engine/src/database/migrations/0071_add_a2a_enabled.sql`:

```sql
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "a2a_enabled" boolean NOT NULL DEFAULT false;
```

- [ ] **Step 3: Register the migration in the journal**

In `meta/_journal.json`, append this object to the `entries` array (after the `0070_oauth_states` entry, `idx: 63`):

```json
{
  "idx": 64,
  "version": "7",
  "when": 1781481600000,
  "tag": "0071_add_a2a_enabled",
  "breakpoints": true
}
```

- [ ] **Step 4: Apply the migration**

Run: `npm run db:migrate -w @polyant/engine`
Expected: `Migrations applied successfully.` and no error. (`ADD COLUMN IF NOT EXISTS` is idempotent.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS (the `Instance` type now carries `a2aEnabled: boolean`).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/instances/schema.ts packages/engine/src/database/migrations/0071_add_a2a_enabled.sql packages/engine/src/database/migrations/meta/_journal.json
git commit -s -m "feat(a2a): add a2a_enabled instance flag column"
```

---

## Task 3: Thread the `a2aEnabled` flag through config, API, and export/import

The flag must be readable at runtime and round-trip through the API and bundles, mirroring `cacheEnabled` exactly.

**Files:**
- Modify: `packages/engine/src/instances/config-resolver.ts` (fallback obj ~lines 115-134; real obj ~line 193)
- Modify: `packages/engine/src/server/instances/instances.controller.ts` (response DTO ~line 83; update DTO ~line 256)
- Modify: `packages/engine/src/instances/store.ts` (the update function that persists flags)
- Modify: `packages/engine/src/instances/export.schema.ts` (schema ~line 116-123)
- Modify: `packages/engine/src/instances/import.service.ts` (create insert ~line 88; overwrite update ~line 205)
- Test: `packages/engine/src/instances/config-resolver.test.ts` (or create if absent) + `packages/engine/src/instances/import.service.test.ts` (or the existing export/import round-trip test)

- [ ] **Step 1: Write the failing config-resolver test**

Add to the config-resolver test (mirror an existing test that asserts a resolved flag like `memoryEnabled`). If there is no existing test file, create `packages/engine/src/instances/config-resolver.test.ts` following the mocking style of a sibling `*.test.ts` in `instances/`.

```ts
it("should_surface_a2aEnabled_from_the_instance_row", async () => {
  // Arrange: mock findInstanceBySlug to return a row with a2aEnabled: true
  // (mirror how the existing tests stub the instance row + secrets/config).
  const cfg = await resolveInstanceConfig(asInstanceSlug("acme"));
  // Assert
  expect(cfg.a2aEnabled).toBe(true);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:unit -w @polyant/engine -- config-resolver`
Expected: FAIL — `a2aEnabled` does not exist on `InstanceConfig` (type error) or is `undefined`.

- [ ] **Step 3: Surface the flag in `InstanceConfig`**

In `config-resolver.ts`:
- Add `a2aEnabled: boolean;` to the `InstanceConfig` interface (near `cacheEnabled`).
- In the unknown-instance fallback object, add `a2aEnabled: false,`.
- In the real config object (near `memoryEnabled: instance.memoryEnabled,`), add `a2aEnabled: instance.a2aEnabled,`.

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm run test:unit -w @polyant/engine -- config-resolver`
Expected: PASS.

- [ ] **Step 5: Thread through the instances controller**

In `instances.controller.ts`:
- Response DTO (near `cacheEnabled: instance.cacheEnabled,`): add `a2aEnabled: instance.a2aEnabled,`.
- Update DTO type (near `cacheEnabled?: boolean;`): add `a2aEnabled?: boolean;`.

Then in `packages/engine/src/instances/store.ts`, find the update function that maps the incoming patch fields to the DB update (search `cacheEnabled` in that file) and add `a2aEnabled` in the same place, mirroring `cacheEnabled` verbatim.

Run: `grep -rn "cacheEnabled" packages/engine/src/instances/store.ts packages/engine/src/server/instances/instances.controller.ts` and ensure every occurrence has an `a2aEnabled` sibling except the embedding-wipe logic (which is cache/embedding-specific and unrelated).

- [ ] **Step 6: Add `a2aEnabled` to the export schema + import**

In `export.schema.ts`, inside `exportInstanceDataSchema` (near `cacheEnabled: z.boolean().default(true),`):

```ts
a2aEnabled: z.boolean().default(false),
```

(No `version` bump needed — additive + defaulted, consistent with how the 1.1 fields were added. Legacy 1.0/1.1 bundles still validate.)

In `import.service.ts`, add `a2aEnabled: data.a2aEnabled,` to BOTH the create-path insert (near `cacheEnabled: data.cacheEnabled,`) and the overwrite-path update block.

Also add `a2aEnabled: instance.a2aEnabled,` to the export builder if the export service constructs the bundle field-by-field (search `cacheEnabled` in `packages/engine/src/instances/export.service.ts` and mirror it).

- [ ] **Step 7: Write a failing export/import round-trip assertion**

In the existing export/import test (search `import.service.test.ts` or `export`), add an assertion that a bundle with `a2aEnabled: true` re-imports to an instance with `a2aEnabled: true`, and that a legacy bundle omitting the field imports as `false`. Mirror the existing round-trip test's arrange/act structure.

- [ ] **Step 8: Run the engine unit suite — expect PASS**

Run: `npm run test:unit -w @polyant/engine`
Expected: PASS (config-resolver + export/import assertions green).

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/engine/src/instances packages/engine/src/server/instances
git commit -s -m "feat(a2a): thread a2aEnabled through config, api, and export/import"
```

---

## Task 4: Agent Card builder (pure function)

**Files:**
- Create: `packages/engine/src/server/a2a/agent-card.builder.ts`
- Test: `packages/engine/src/server/a2a/agent-card.builder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// agent-card.builder.test.ts
import { describe, it, expect } from "vitest";
import { buildAgentCard } from "./agent-card.builder.js";
import { asInstanceSlug, asInstanceUuid } from "../../instances/identifiers.js";

const baseInstance = {
  id: asInstanceUuid("00000000-0000-0000-0000-000000000001"),
  slug: asInstanceSlug("acme-bot"),
  name: "Acme Bot",
  description: "Helps with Acme things",
  authEnabled: false,
} as const;

describe("buildAgentCard", () => {
  it("should_build_a_single_conversation_skill_card_with_absolute_jsonrpc_url", () => {
    const card = buildAgentCard(baseInstance as never, "https://polyant.example.com");
    expect(card.name).toBe("Acme Bot");
    expect(card.description).toBe("Helps with Acme things");
    expect(card.url).toBe("https://polyant.example.com/a2a/acme-bot/jsonrpc");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.defaultInputModes).toEqual(["text"]);
    expect(card.defaultOutputModes).toEqual(["text"]);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("conversation");
    expect(card.skills[0].tags).toEqual([]);
  });

  it("should_omit_security_when_authDisabled", () => {
    const card = buildAgentCard({ ...baseInstance, authEnabled: false } as never, "https://x");
    expect(card.securitySchemes).toBeUndefined();
    expect(card.security).toBeUndefined();
  });

  it("should_declare_bearer_security_when_authEnabled", () => {
    const card = buildAgentCard({ ...baseInstance, authEnabled: true } as never, "https://x");
    expect(card.securitySchemes).toBeDefined();
    expect(card.security).toBeDefined();
  });

  it("should_pass_through_tags_when_provided", () => {
    const card = buildAgentCard(baseInstance as never, "https://x", ["sales", "crm"]);
    expect(card.skills[0].tags).toEqual(["sales", "crm"]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:unit -w @polyant/engine -- agent-card.builder`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

```ts
// agent-card.builder.ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AgentCard } from "@a2a-js/sdk";
import type { Instance } from "../../instances/schema.js";

/**
 * Build the A2A Agent Card for an instance. Pure: card content derives only
 * from instance metadata + the public base URL. A Polyant instance is a
 * conversational agent, so it advertises a single generic "conversation" skill.
 */
export function buildAgentCard(instance: Instance, baseUrl: string, tags: string[] = []): AgentCard {
  const jsonRpcUrl = `${baseUrl}/a2a/${instance.slug}/jsonrpc`;
  const card: AgentCard = {
    name: instance.name,
    description: instance.description ?? "",
    protocolVersion: "0.3.0",
    version: "1.0.0",
    url: jsonRpcUrl,
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "conversation",
        name: "Conversation",
        description: instance.description ?? instance.name,
        tags,
      },
    ],
  };
  if (instance.authEnabled) {
    card.securitySchemes = {
      bearer: { type: "http", scheme: "bearer", description: "Per-instance API key" },
    };
    card.security = [{ bearer: [] }];
  }
  return card;
}
```

Note: import the actual `Instance` row type from `instances/schema.ts` (the Drizzle `$inferSelect` type — check the exact exported name in that file and use it). If field shapes on `AgentCard` differ from the SDK's actual type (the SDK is the source of truth), adjust to satisfy the compiler — the test asserts behavior, not the SDK's field names.

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm run test:unit -w @polyant/engine -- agent-card.builder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/server/a2a/agent-card.builder.ts packages/engine/src/server/a2a/agent-card.builder.test.ts
git commit -s -m "feat(a2a): agent card builder"
```

---

## Task 5: Context helpers (pure functions)

**Files:**
- Create: `packages/engine/src/server/a2a/a2a-context.ts`
- Test: `packages/engine/src/server/a2a/a2a-context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// a2a-context.test.ts
import { describe, it, expect } from "vitest";
import { extractText, contextIdToConversationId } from "./a2a-context.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

describe("extractText", () => {
  it("should_join_text_parts_and_ignore_non_text", () => {
    const msg = {
      kind: "message",
      messageId: "m1",
      role: "user",
      parts: [
        { kind: "text", text: "Hello " },
        { kind: "file", file: { uri: "x" } },
        { kind: "text", text: "world" },
      ],
    } as never;
    expect(extractText(msg)).toBe("Hello world");
  });

  it("should_return_empty_string_when_no_text_parts", () => {
    const msg = { kind: "message", messageId: "m1", role: "user", parts: [] } as never;
    expect(extractText(msg)).toBe("");
  });
});

describe("contextIdToConversationId", () => {
  it("should_derive_a_slug_prefixed_conversation_id", () => {
    expect(contextIdToConversationId(asInstanceSlug("acme"), "ctx-123")).toBe("a2a:acme:ctx-123");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:unit -w @polyant/engine -- a2a-context`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// a2a-context.ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "@a2a-js/sdk";
import type { InstanceSlug } from "../../instances/identifiers.js";

/** Concatenate the text parts of an A2A Message; non-text parts are ignored (MVP). */
export function extractText(message: Message): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Deterministically map an A2A contextId to a Polyant conversationId. The SDK
 * (or client) always supplies a contextId, so the same contextId across turns
 * resolves to the same conversation — this is what makes A2A multi-turn work.
 */
export function contextIdToConversationId(slug: InstanceSlug, contextId: string): string {
  return `a2a:${slug}:${contextId}`;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm run test:unit -w @polyant/engine -- a2a-context`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/server/a2a/a2a-context.ts packages/engine/src/server/a2a/a2a-context.test.ts
git commit -s -m "feat(a2a): context helpers (extractText, contextId mapping)"
```

---

## Task 6: PolyantAgentExecutor (the pipeline bridge)

The core. `createPolyantExecutor(slug, streamHandler)` returns an `AgentExecutor` whose `execute` runs the streaming pipeline and publishes A2A events; `cancelTask` aborts the in-flight run.

**Files:**
- Create: `packages/engine/src/server/a2a/polyant-agent.executor.ts`
- Test: `packages/engine/src/server/a2a/polyant-agent.executor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// polyant-agent.executor.test.ts
import { describe, it, expect } from "vitest";
import { createPolyantExecutor } from "./polyant-agent.executor.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import type { StreamMessageHandler, StreamOutgoingMessage } from "../../channels/types.js";

function fakeStream(parts: Array<{ type: string; text?: string }>, finalText: string): StreamOutgoingMessage {
  return {
    textStream: (async function* () { yield finalText; })(),
    fullStream: (async function* () { for (const p of parts) yield p; })(),
    completed: Promise.resolve({ text: finalText }),
  };
}

function fakeBus() {
  const published: any[] = [];
  return { published, publish: (e: any) => published.push(e), finished: () => { (published as any).finished = true; } };
}

const ctx = {
  taskId: "t1",
  contextId: "c1",
  userMessage: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text: "hi" }] },
  task: undefined,
} as never;

describe("createPolyantExecutor.execute", () => {
  it("should_publish_submitted_working_artifacts_and_completed_with_full_text", async () => {
    const handler: StreamMessageHandler = async () =>
      fakeStream([{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }], "Hello");
    const exec = createPolyantExecutor(asInstanceSlug("acme"), handler);
    const bus = fakeBus();

    await exec.execute(ctx, bus as never);

    const kinds = bus.published.map((e) => e.kind ?? e.status?.state);
    expect(bus.published[0].kind).toBe("task");
    expect(bus.published.some((e) => e.kind === "status-update" && e.status.state === "working")).toBe(true);
    expect(bus.published.filter((e) => e.kind === "artifact-update").length).toBe(2);
    const final = bus.published.at(-1);
    expect(final.kind).toBe("status-update");
    expect(final.status.state).toBe("completed");
    expect(final.final).toBe(true);
    expect(final.status.message.parts[0].text).toBe("Hello");
    expect((bus.published as any).finished).toBe(true);
  });

  it("should_pass_the_extracted_user_text_and_derived_conversationId_into_the_pipeline", async () => {
    let seen: any;
    const handler: StreamMessageHandler = async (msg) => { seen = msg; return fakeStream([], "ok"); };
    const exec = createPolyantExecutor(asInstanceSlug("acme"), handler);
    await exec.execute(ctx, fakeBus() as never);
    expect(seen.text).toBe("hi");
    expect(seen.metadata.conversationId).toBe("a2a:acme:c1");
    expect(seen.channelType).toBe("agent");
  });

  it("should_publish_failed_when_the_pipeline_throws", async () => {
    const handler: StreamMessageHandler = async () => { throw new Error("boom"); };
    const exec = createPolyantExecutor(asInstanceSlug("acme"), handler);
    const bus = fakeBus();
    await exec.execute(ctx, bus as never);
    const final = bus.published.at(-1);
    expect(final.kind).toBe("status-update");
    expect(final.status.state).toBe("failed");
    expect(final.final).toBe(true);
    expect((bus.published as any).finished).toBe(true);
  });

  it("should_abort_the_pipeline_signal_on_cancelTask", async () => {
    let capturedSignal: AbortSignal | undefined;
    const handler: StreamMessageHandler = async (_msg, signal) => {
      capturedSignal = signal;
      // never-resolving stream so cancelTask lands mid-flight
      return {
        textStream: (async function* () {})(),
        fullStream: (async function* () { await new Promise(() => {}); })(),
        completed: new Promise(() => {}),
      };
    };
    const exec = createPolyantExecutor(asInstanceSlug("acme"), handler);
    const bus = fakeBus();
    const running = exec.execute(ctx, bus as never);
    // let execute reach the pipeline call
    await new Promise((r) => setTimeout(r, 5));
    await exec.cancelTask("t1", bus as never);
    expect(capturedSignal?.aborted).toBe(true);
    // avoid an unhandled hang: the never-resolving execute is abandoned by the test
    void running;
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:unit -w @polyant/engine -- polyant-agent.executor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the executor**

```ts
// polyant-agent.executor.ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { Message } from "@a2a-js/sdk";
import type { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { IncomingMessage, StreamMessageHandler } from "../../channels/types.js";
import type { InstanceSlug } from "../../instances/identifiers.js";
import { extractText, contextIdToConversationId } from "./a2a-context.js";

/**
 * Bridge the A2A execution seam to the Polyant streaming pipeline. One code
 * path serves both message/send and message/stream: the DefaultRequestHandler
 * collapses the published event stream into a Task for the non-streaming call.
 * Tasks are ephemeral — the pipeline is synchronous single-turn.
 */
export function createPolyantExecutor(
  slug: InstanceSlug,
  streamHandler: StreamMessageHandler,
): AgentExecutor {
  const aborts = new Map<string, AbortController>();

  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const { taskId, contextId, userMessage, task } = ctx;
      const abort = new AbortController();
      aborts.set(taskId, abort);
      const now = () => new Date().toISOString();

      try {
        if (!task) {
          bus.publish({
            kind: "task",
            id: taskId,
            contextId,
            status: { state: "submitted", timestamp: now() },
            history: [userMessage],
          });
        }
        bus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: { state: "working", timestamp: now() },
          final: false,
        });

        const msg: IncomingMessage = {
          channelType: "agent",
          channelId: `a2a:${slug}`,
          instanceId: slug,
          userName: "a2a",
          text: extractText(userMessage),
          metadata: { conversationId: contextIdToConversationId(slug, contextId), source: "a2a" },
        };

        const stream = await streamHandler(msg, abort.signal);

        let first = true;
        for await (const part of stream.fullStream as AsyncIterable<{ type: string; text?: string }>) {
          if (abort.signal.aborted) break;
          if (part.type === "text-delta" && part.text) {
            bus.publish({
              kind: "artifact-update",
              taskId,
              contextId,
              artifact: { artifactId: "response", parts: [{ kind: "text", text: part.text }] },
              append: !first,
              lastChunk: false,
            });
            first = false;
          }
        }

        if (abort.signal.aborted) {
          bus.publish({
            kind: "status-update",
            taskId,
            contextId,
            status: { state: "canceled", timestamp: now() },
            final: true,
          });
          return;
        }

        const { text: fullText } = await stream.completed;
        const reply: Message = {
          kind: "message",
          messageId: randomUUID(),
          role: "agent",
          parts: [{ kind: "text", text: fullText }],
          contextId,
          taskId,
        };
        bus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: { state: "completed", timestamp: now(), message: reply },
          final: true,
        });
      } catch {
        bus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: { state: "failed", timestamp: now() },
          final: true,
        });
      } finally {
        aborts.delete(taskId);
        bus.finished();
      }
    },

    cancelTask: async (taskId: string): Promise<void> => {
      aborts.get(taskId)?.abort();
    },
  };
}
```

If the SDK's event object types reject any field name here, the SDK is the source of truth — adjust field names to compile while keeping the same shape. The tests assert behavior, so they will guide you.

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm run test:unit -w @polyant/engine -- polyant-agent.executor`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/server/a2a/polyant-agent.executor.ts packages/engine/src/server/a2a/polyant-agent.executor.test.ts
git commit -s -m "feat(a2a): pipeline-bridging agent executor"
```

---

## Task 7: Handler registry (per-slug, TTL-cached)

**Files:**
- Create: `packages/engine/src/server/a2a/a2a-handler.registry.ts`
- Test: `packages/engine/src/server/a2a/a2a-handler.registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// a2a-handler.registry.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../../instances/identifiers.js";

vi.mock("../../instances/store.js", () => ({
  findInstanceBySlug: vi.fn(async () => ({
    id: "u1", slug: "acme", name: "Acme", description: "d", authEnabled: false,
  })),
}));

import { findInstanceBySlug } from "../../instances/store.js";
import { A2aHandlerRegistry } from "./a2a-handler.registry.js";

const fakeStreamHandler = (async () => ({
  textStream: (async function* () {})(),
  fullStream: (async function* () {})(),
  completed: Promise.resolve({ text: "" }),
})) as never;

describe("A2aHandlerRegistry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should_build_a_handler_and_cache_it_per_slug", async () => {
    const reg = new A2aHandlerRegistry();
    reg.setStreamMessageHandler(fakeStreamHandler);
    const h1 = await reg.getHandler(asInstanceSlug("acme"));
    const h2 = await reg.getHandler(asInstanceSlug("acme"));
    expect(h1).toBe(h2); // cached — same instance
    expect(findInstanceBySlug).toHaveBeenCalledTimes(1); // built once
  });

  it("should_throw_when_the_instance_is_missing", async () => {
    (findInstanceBySlug as any).mockResolvedValueOnce(undefined);
    const reg = new A2aHandlerRegistry();
    reg.setStreamMessageHandler(fakeStreamHandler);
    await expect(reg.getHandler(asInstanceSlug("ghost"))).rejects.toThrow();
  });

  it("should_throw_when_the_stream_handler_is_not_set", async () => {
    const reg = new A2aHandlerRegistry();
    await expect(reg.getHandler(asInstanceSlug("acme"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:unit -w @polyant/engine -- a2a-handler.registry`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

```ts
// a2a-handler.registry.ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { config } from "../../config.js";
import { TtlCache } from "../../utils/ttl-cache.js";
import { findInstanceBySlug } from "../../instances/store.js";
import type { InstanceSlug } from "../../instances/identifiers.js";
import type { StreamMessageHandler } from "../../channels/types.js";
import { buildAgentCard } from "./agent-card.builder.js";
import { createPolyantExecutor } from "./polyant-agent.executor.js";

/**
 * Lazily builds and TTL-caches one DefaultRequestHandler per instance slug (the
 * Agent Card is per-instance). A single InMemoryTaskStore is shared. The 30s
 * TTL matches config-resolver, so card edits (name/description) propagate
 * without a restart.
 */
@Injectable()
export class A2aHandlerRegistry {
  private streamHandler?: StreamMessageHandler;
  private readonly taskStore = new InMemoryTaskStore();
  private readonly cache = new TtlCache<string, DefaultRequestHandler>({ maxSize: 200, ttlMs: 30_000 });

  setStreamMessageHandler(handler: StreamMessageHandler): void {
    this.streamHandler = handler;
  }

  async getHandler(slug: InstanceSlug): Promise<DefaultRequestHandler> {
    const cached = this.cache.get(slug);
    if (cached) return cached;
    if (!this.streamHandler) throw new Error("A2aHandlerRegistry: stream message handler not set");

    const instance = await findInstanceBySlug(slug);
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);

    const baseUrl = config.server.baseUrl ?? `http://localhost:${config.server.port}`;
    const card = buildAgentCard(instance, baseUrl);
    const executor = createPolyantExecutor(slug, this.streamHandler);
    const handler = new DefaultRequestHandler(card, this.taskStore, executor);

    this.cache.set(slug, handler);
    return handler;
  }
}
```

Note: this is a NestJS `@Injectable` class. Per the repo convention (tsx doesn't emit decorator metadata), it has **no constructor injection** — nothing to `@Inject`. If you later add a constructor dependency, it MUST use explicit `@Inject(...)` (enforced by the `polyant/require-inject-in-nest-classes` ESLint rule).

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm run test:unit -w @polyant/engine -- a2a-handler.registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/server/a2a/a2a-handler.registry.ts packages/engine/src/server/a2a/a2a-handler.registry.test.ts
git commit -s -m "feat(a2a): per-slug request handler registry"
```

---

## Task 8: Controller + module + wiring

**Files:**
- Create: `packages/engine/src/server/a2a/a2a.controller.ts`
- Create: `packages/engine/src/server/a2a/a2a.module.ts`
- Modify: `packages/engine/src/server/server.module.ts`
- Modify: `packages/engine/src/server/main.ts`
- Test: `packages/engine/src/server/a2a/a2a.controller.test.ts`

- [ ] **Step 1: Write the failing controller gate test**

```ts
// a2a.controller.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";

vi.mock("../../instances/config-resolver.js", () => ({
  resolveInstanceConfig: vi.fn(),
}));
vi.mock("../openai/instance-api-key-auth.js", () => ({
  validateInstanceApiKey: vi.fn(async () => {}),
}));

import { resolveInstanceConfig } from "../../instances/config-resolver.js";
import { validateInstanceApiKey } from "../openai/instance-api-key-auth.js";
import { A2aController } from "./a2a.controller.js";

function res() {
  return { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), json: vi.fn() } as never;
}
function req(auth?: string) {
  return { headers: auth ? { authorization: auth } : {}, method: "POST", body: {} } as never;
}

describe("A2aController", () => {
  let registry: { getHandler: ReturnType<typeof vi.fn> };
  let controller: A2aController;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = { getHandler: vi.fn(async () => ({})) };
    controller = new A2aController(registry as never);
  });

  it("should_404_the_card_when_a2a_disabled", async () => {
    (resolveInstanceConfig as any).mockResolvedValue({ a2aEnabled: false });
    await expect(controller.agentCard("acme", req() as never, res())).rejects.toBeInstanceOf(NotFoundException);
    expect(registry.getHandler).not.toHaveBeenCalled();
  });

  it("should_404_jsonrpc_when_a2a_disabled_before_touching_auth", async () => {
    (resolveInstanceConfig as any).mockResolvedValue({ a2aEnabled: false });
    await expect(controller.jsonrpc("acme", req("Bearer k") as never, res())).rejects.toBeInstanceOf(NotFoundException);
    expect(validateInstanceApiKey).not.toHaveBeenCalled();
  });

  it("should_enforce_api_key_on_jsonrpc_when_enabled", async () => {
    (resolveInstanceConfig as any).mockResolvedValue({ a2aEnabled: true });
    await controller.jsonrpc("acme", req("Bearer k") as never, res());
    expect(validateInstanceApiKey).toHaveBeenCalledWith("acme", "Bearer k");
    expect(registry.getHandler).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run test:unit -w @polyant/engine -- a2a.controller`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

```ts
// a2a.controller.ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, Post, Param, Req, Res, Inject, NotFoundException } from "@nestjs/common";
import type { Request, Response } from "express";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { Public } from "../../auth/decorators/public.decorator.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { resolveInstanceConfig } from "../../instances/config-resolver.js";
import { validateInstanceApiKey } from "../openai/instance-api-key-auth.js";
import { A2aHandlerRegistry } from "./a2a-handler.registry.js";

const noop = (): void => {};

/**
 * A2A inbound HTTP bridge. Thin: routing, the a2a_enabled gate (404 when off —
 * does not reveal existence), per-instance API-key auth on JSON-RPC, then
 * delegate to the SDK's Express middlewares via the per-slug handler. Uses
 * @Res() so the SDK owns the JSON-RPC/SSE response body (mirrors
 * instance-chat-stream.controller.ts).
 */
@Controller("a2a")
export class A2aController {
  constructor(@Inject(A2aHandlerRegistry) private readonly registry: A2aHandlerRegistry) {}

  @Public()
  @Get(":slug/.well-known/agent-card.json")
  async agentCard(@Param("slug") slug: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.assertEnabled(slug);
    const handler = await this.registry.getHandler(asInstanceSlug(slug));
    await agentCardHandler({ agentCardProvider: handler })(req, res, noop);
  }

  @Public()
  @Post(":slug/jsonrpc")
  async jsonrpc(@Param("slug") slug: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.assertEnabled(slug);
    await validateInstanceApiKey(slug, req.headers["authorization"] as string | undefined);
    const handler = await this.registry.getHandler(asInstanceSlug(slug));
    await jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication })(req, res, noop);
  }

  /** The Agent Card stays unauthenticated (discovery); the a2a_enabled gate still applies. */
  private async assertEnabled(slug: string): Promise<void> {
    const cfg = await resolveInstanceConfig(asInstanceSlug(slug));
    if (!cfg.a2aEnabled) throw new NotFoundException();
  }
}
```

If `agentCardHandler` / `jsonRpcHandler` factory option names differ from `{ agentCardProvider }` / `{ requestHandler, userBuilder }`, use the exact names from the installed SDK's `.d.ts` (`packages/engine/node_modules/@a2a-js/sdk/server/express`). The README snippet in the spec is the reference.

- [ ] **Step 4: Implement the module**

```ts
// a2a.module.ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from "@nestjs/common";
import { A2aController } from "./a2a.controller.js";
import { A2aHandlerRegistry } from "./a2a-handler.registry.js";

@Module({
  controllers: [A2aController],
  providers: [A2aHandlerRegistry],
  exports: [A2aHandlerRegistry],
})
export class A2aModule {}
```

- [ ] **Step 5: Register the module + inject the stream handler**

In `server.module.ts`, add `A2aModule` to the `@Module` `imports` array (alongside `OpenAIModule`). Add the import line at the top.

In `main.ts`, right after the two `openaiService.set...` lines, add:

```ts
// Inject the message handler into the A2A registry (same pattern as OpenAIService)
const a2aRegistry = app.get(A2aHandlerRegistry);
a2aRegistry.setStreamMessageHandler(streamMessageHandler);
```

Add the import: `import { A2aHandlerRegistry } from "./a2a/a2a-handler.registry.js";` at the top of `main.ts`.

- [ ] **Step 6: Run the controller test — expect PASS**

Run: `npm run test:unit -w @polyant/engine -- a2a.controller`
Expected: PASS.

- [ ] **Step 7: Typecheck + full engine unit suite**

Run: `npm run typecheck -w @polyant/engine && npm run test:unit -w @polyant/engine`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/server/a2a packages/engine/src/server/server.module.ts packages/engine/src/server/main.ts
git commit -s -m "feat(a2a): controller, module, and pipeline wiring"
```

---

## Task 9: Web Settings toggle

**Files:**
- Modify: `packages/web/src/lib/api.ts` (update payload type ~line 237-267)
- Modify: `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx`

- [ ] **Step 1: Add the field to the API client type**

In `api.ts`, inside the `instances.update(slug, data)` payload type (near `cacheEnabled?: boolean;`), add:

```ts
a2aEnabled?: boolean;
```

- [ ] **Step 2: Add the toggle state + Switch + save payload**

In `settings-tab.tsx`:
- Add state near the other flags: `const [a2aEnabled, setA2aEnabled] = useState(instance.a2aEnabled);`
- Add a `<Switch>` block mirroring the Memory toggle (label `A2A` — add an i18n key `settings.tab.a2a` in both `packages/web/src/lib/i18n` locale files, English + Italian):

```tsx
<div className="flex items-center justify-between">
  <Label>{t("settings.tab.a2a")}</Label>
  <Switch checked={a2aEnabled} onCheckedChange={setA2aEnabled} />
</div>
```

- In the save handler that calls `api.instances.update(instance.slug, {...})`, add `a2aEnabled,` to the payload object (near `cacheEnabled,`).

- [ ] **Step 3: Typecheck + lint web**

Run: `npm run typecheck -w @polyant/web && npm run lint -w @polyant/web`
Expected: both PASS. (If `instance.a2aEnabled` is untyped on the web-side instance type, add `a2aEnabled: boolean;` to that type — search where `cacheEnabled` is declared on the web instance type.)

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/app/\(admin\)/instances packages/web/src/lib/i18n
git commit -s -m "feat(a2a): settings toggle for a2a exposure"
```

---

## Task 10: End-to-end verification (live smoke test)

The unit tests cover our logic; this task verifies the SDK↔NestJS wiring against a running server (the one integration risk: invoking the SDK's Express middlewares from a NestJS `@Res()` controller, and whether the SDK collapses the event stream into a Task for `message/send`).

**Files:** none (verification only).

- [ ] **Step 1: Enable A2A on a test instance**

Start the engine (`npm run dev`) and enable `a2a_enabled` on a known instance either via the Settings toggle or:
`PATCH /api/instances/<slug>` with body `{ "a2aEnabled": true }` (and set `authEnabled: false` on it for this smoke test to skip the key).

- [ ] **Step 2: Fetch the Agent Card**

Run:
```bash
curl -s http://localhost:4000/a2a/<slug>/.well-known/agent-card.json | jq .
```
Expected: JSON with `name`, `capabilities.streaming: true`, `url` ending `/a2a/<slug>/jsonrpc`, one `conversation` skill. A disabled instance returns 404.

- [ ] **Step 3: `message/send` (synchronous)**

Run:
```bash
curl -s http://localhost:4000/a2a/<slug>/jsonrpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"kind":"message","messageId":"m1","role":"user","parts":[{"kind":"text","text":"Say hi in one word"}]}}}' | jq .
```
Expected: a JSON-RPC result carrying a Task with `status.state: "completed"` and the agent's reply text (in `status.message.parts[0].text` and/or a `response` artifact). Confirm a conversation row `a2a:<slug>:<contextId>` was created.

- [ ] **Step 4: `message/stream` (SSE)**

Run:
```bash
curl -sN http://localhost:4000/a2a/<slug>/jsonrpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"2","method":"message/stream","params":{"message":{"kind":"message","messageId":"m2","role":"user","parts":[{"kind":"text","text":"Count to five"}]}}}'
```
Expected: an SSE stream of events — a `task` (submitted), a `working` status-update, one or more `artifact-update` chunks with incremental text, then a final `completed` status-update with `final: true`.

- [ ] **Step 5: Multi-turn**

Repeat Step 3 with the SAME `contextId` returned in Step 3's Task. Expected: the reply reflects prior-turn context (same `a2a:<slug>:<contextId>` conversation reused).

- [ ] **Step 6: Auth gate**

Set `authEnabled: true` on the instance. Repeat Step 3 with no `Authorization` header → expect a 401/Unauthorized. Repeat with `-H "authorization: Bearer <the instance api key>"` → expect success. The Agent Card (Step 2) still returns 200 without a key (discovery is unauthenticated) but now shows `securitySchemes`.

- [ ] **Step 7: Full gate + typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS across workspaces.

**If Step 3/4 fail** because the SDK's Express middleware does not run correctly when invoked directly from the NestJS `@Res()` controller: fall back to mounting the SDK middlewares on the raw Express instance in `main.ts` using a dynamic slug router (`app.getHttpAdapter().getInstance()` → `expressApp.all("/a2a/:slug/jsonrpc", ...)`), keeping the gate/auth checks inline. Keep the registry + executor unchanged. Document whichever wiring works in the module file's header comment.

---

## Self-Review (completed during planning)

- **Spec coverage:** flag/opt-in (Tasks 2,3,9) · URL scheme (Task 8) · SDK-backed handler (Tasks 6,7,8) · single conversation skill (Task 4) · auth reuse + 404 gate (Task 8) · contextId→conversationId multi-turn (Tasks 5,6,10) · ephemeral task store (Task 7) · export/import (Task 3) · tests per unit (Tasks 3-8) · live verification (Task 10). Every spec section maps to a task.
- **Deviation:** Agent Card `tags` deferred to `[]` (documented at the top). Builder signature keeps `tags` so it is a one-line follow-up.
- **Type consistency:** `buildAgentCard(instance, baseUrl, tags=[])`, `createPolyantExecutor(slug, streamHandler)`, `contextIdToConversationId(slug, contextId)`, `extractText(message)`, `A2aHandlerRegistry.getHandler(slug)` / `.setStreamMessageHandler(h)` — names are consistent across Tasks 4-10.
- **Placeholder scan:** no TBD/TODO; every code step shows full code; the two SDK-shape caveats point at the installed `.d.ts` as the source of truth rather than leaving a blank.
