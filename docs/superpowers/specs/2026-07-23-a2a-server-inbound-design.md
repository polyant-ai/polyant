# A2A Server (inbound) — Design

**Date:** 2026-07-23
**Status:** Approved (design)
**Scope:** Expose each Polyant instance as an [A2A](https://a2a-protocol.org) (Agent2Agent) compliant agent, so external A2A clients (orchestrators, other frameworks) can discover and invoke it over HTTP.

This is the **server / inbound** half of A2A support. The **client / outbound** half (Polyant calling remote A2A agents as a tool) is a separate sub-project with its own spec, branch, and PR.

## Locked decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Protocol surface | `message/send` + `message/stream` + light `tasks/get`/`tasks/cancel`. No durable task store. | Polyant's pipeline is synchronous single-turn; each call runs the pipeline and returns a `completed` Task. No long-running async jobs exist to persist. |
| Wire implementation | SDK-backed: `@a2a-js/sdk`. | Reference implementation guarantees JSON-RPC envelope, SSE event framing, and Task/Message object correctness. Hand-rolling a correctness/protocol path is more code and more risk. |
| Agent Card skills | A single generic `conversation` skill. | A Polyant instance is a conversational agent, not a set of discrete capabilities with distinct I/O modes. Polyant skills are prompt fragments; forcing a 1:1 A2A-skill mapping is semantically wrong. |
| Exposure gating | Opt-in per instance via a new `a2a_enabled` boolean flag. | Not every instance should publish an Agent Card. Booleans on `instances` are the established pattern (`memoryEnabled`, `authEnabled`, `cacheEnabled`, …). |
| Authentication | Reuse the per-instance API key (`validateInstanceApiKey`). | Same mechanism `/v1/chat/completions` and the native SSE endpoint already use. |

## Protocol grounding

A2A (spec ≥ 1.0, protocol version reported in the card):

- **Agent Card** — JSON document describing the agent (name, description, version, `url`, `capabilities`, `skills`, `defaultInputModes`/`OutputModes`, `securitySchemes`). Discovered at `.well-known/agent-card.json` relative to the agent's base.
- **JSON-RPC 2.0 over HTTP** — methods: `message/send` (sync, returns Task or Message), `message/stream` (SSE stream of Task / `status-update` / `artifact-update` events), `tasks/get`, `tasks/cancel`.
- **Task lifecycle** — `submitted → working → {completed | failed | input-required | canceled}`. Streaming events carry a `final` flag on the terminal `status-update`.
- **TypeScript SDK** — `@a2a-js/sdk` (types) · `@a2a-js/sdk/server` (`DefaultRequestHandler`, `InMemoryTaskStore`, `AgentExecutor`, `RequestContext`, `ExecutionEventBus`) · `@a2a-js/sdk/server/express` (Express middlewares `agentCardHandler`, `jsonRpcHandler`). `AgentExecutor.execute(requestContext, eventBus)` is the single integration seam: it publishes events to the bus and the handler shapes the sync/stream response.

## Architecture

New NestJS module `packages/engine/src/server/a2a/`, mirroring `server/openai/`. NestJS runs on Express, so the SDK's Express middlewares can be invoked directly from a controller using `@Res()` passthrough (the same pattern `instance-chat-stream.controller.ts` uses for SSE).

```
server/a2a/
  a2a.module.ts               NestJS wiring
  a2a.controller.ts           thin HTTP bridge (routing, gate, auth, delegate)
  a2a-handler.registry.ts     per-slug DefaultRequestHandler cache
  agent-card.builder.ts       pure: instance data -> AgentCard
  polyant-agent.executor.ts   AgentExecutor: bridge execute() -> pipeline
  a2a-context.ts              contextId <-> conversationId helper
```

### Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /a2a/:slug/.well-known/agent-card.json` | `@Public()` + gate | Agent Card for the instance |
| `POST /a2a/:slug/jsonrpc` | `@Public()` + gate | JSON-RPC: `message/send`, `message/stream` (SSE), `tasks/get`, `tasks/cancel` |

- The card's `url` field is built as `` `${config.server.baseUrl ?? `http://localhost:${config.server.port}`}/a2a/${slug}/jsonrpc` `` — the exact base-URL pattern already used by `webhook-sources.controller.ts` and `oauth-providers.ts`. `X-Forwarded-*` is honored via the existing Express trust-proxy setting.
- There is **no global discovery endpoint**. A caller must know the slug.

### Controller (thin bridge)

1. Resolve `:slug`.
2. **Gate:** if `a2a_enabled` is false → **404** (do not reveal existence — not 403).
3. **Auth:** if the instance's `authEnabled` is true → require a valid Bearer key via `validateInstanceApiKey` (shared helper); else open.
4. Delegate to the per-slug handler from the registry, using `@Res()` passthrough so the SDK owns the JSON-RPC/SSE response body.

### Handler registry

Lazily builds and caches one `DefaultRequestHandler(agentCard, taskStore, executor)` per slug (the card is per-instance). A single `InMemoryTaskStore` is shared across slugs. Cache TTL 30s, aligned with `config-resolver`, so edits to the instance name/description or enabled skills propagate into the published card without a restart.

### Agent Card builder (pure)

`buildAgentCard(instance, enabledSkillSlugs, baseUrl): AgentCard`:

- `name`, `description`, `version` from instance metadata.
- `capabilities.streaming = true`.
- `defaultInputModes`/`defaultOutputModes = ['text']`.
- `skills = [{ id: 'conversation', name: 'Conversation', description: <instance description>, tags: <enabled skill slugs> }]`.
- `url` = the JSON-RPC endpoint (absolute).
- `securitySchemes` + `security` populated with a bearer scheme **iff** `authEnabled`; omitted otherwise.

### Executor bridge (the core)

`PolyantAgentExecutor implements AgentExecutor`. `execute(requestContext, eventBus)`:

1. Extract user text from `userMessage.parts` (text parts only; file/data parts skipped in MVP).
2. Resolve the conversation: A2A `contextId` → Polyant `conversationId`. If `contextId` is present, reuse it; otherwise mint `a2a:{slug}:{uuid}` (slug-prefixed convention). The chosen value is returned to the client as `contextId`, enabling multi-turn.
3. Build a synthetic `IncomingMessage` entering the pipeline via the existing **`agent` synthetic-channel convention** (no opt-out seed, bypasses the message coordinator).
4. **`message/send`:** publish `Task(submitted, history=[userMessage])` → `status-update(working)` → run `handleMessage(msg, signal)` → `status-update(completed, message=<agent reply as a text-part Message>)` with `final: true`.
5. **`message/stream`:** publish `Task(submitted)` → `status-update(working)` → consume `handleMessageStream(msg, signal)`'s `fullStream`, mapping `text-delta` chunks to `artifact-update` events (artifactId `response`, appended) → terminal `status-update(completed, final: true)`.
6. **Cancellation:** `cancelTask` and SSE client disconnect abort the pipeline `AbortSignal` (end-to-end abort support already exists).
7. **Errors:** a pipeline throw is caught and published as `status-update(failed)` + surfaced as a JSON-RPC error.

## Data / schema changes

- Migration: add `a2a_enabled boolean NOT NULL DEFAULT false` to `instances` (hand-written incremental migration; no snapshot files in this repo).
- `config-resolver.ts` exposes the flag in the resolved instance config.
- Instance export/import bundle: add `a2aEnabled`, bumping the format `1.1 → 1.2`, defined with `.default(false)` so legacy 1.0/1.1 bundles still validate.

## Reuse (no new machinery)

- Pipeline: `handleMessage` / `handleMessageStream` (+ `AbortSignal`).
- Auth: `validateInstanceApiKey`.
- Base URL: `config.server.baseUrl` fallback pattern.
- SSE controller pattern: `@Res()` passthrough from `instance-chat-stream.controller.ts`.
- Synthetic-channel convention: the existing `agent` channel path.

## Deliberate simplifications (ponytail)

- **Ephemeral tasks, no durable store** — matches surface B. Ceiling: a process restart loses task lookup; acceptable because tasks complete synchronously. Upgrade path: swap `InMemoryTaskStore` for a DB-backed store if long-running A2A tasks are ever needed.
- **Text parts only** — file/data `Part`s are skipped on input and not emitted on output. Add when a concrete client needs them.
- **No reasoning/tool-call timeline in the stream** — only text deltas map to A2A artifacts. Add intermediate `status-update` mapping if an orchestrator needs the step timeline.
- **Boolean flag, not a channel row** — A2A has no outbound transport/credentials, so a channel adapter + Zod config would be dead machinery.

## Testing

- `agent-card.builder` — card shape; security scheme present iff `authEnabled`; tags = enabled skill slugs.
- `polyant-agent.executor` — `send` returns a `completed` Task carrying the agent text; `stream` emits `working → artifact-update(s) → completed(final)`; abort path; error → `failed`.
- `a2a.controller` — 404 when `a2a_enabled` off; 401 when `authEnabled` and key missing/invalid; a reused `contextId` maps to the same `conversationId` (multi-turn).
- `a2a-handler.registry` — per-slug caching + invalidation on config change.

## Out of scope

- A2A client/outbound (separate sub-project).
- gRPC and HTTP+JSON/REST transport bindings (JSON-RPC only for v1).
- Push notifications (`capabilities.pushNotifications = false`).
- Durable/long-running tasks, `tasks/resubscribe`.
- Authenticated extended Agent Card.
