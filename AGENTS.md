# Agent System

## Overview

Polyant uses a **Supervisor + Sub-agents** pattern built on Vercel AI SDK v4.

All user messages are handled by a single **Supervisor** agent that has access to a per-agent set of tools (memory, web search, knowledge, channel-specific integrations, ...). For complex multi-step work, the Supervisor can spawn isolated sub-agents.

```
User Message
    |
    v
[Agent Resolution] (look up agent config from PostgreSQL)
    |
    v
[Supervisor] (tier: standard, max 15 steps)
    |--- searchMemory      (hybrid pgvector + PG FTS)
    |--- webSearch         (Tavily API, optional)
    |--- saveMemory        (explicit, user-requested only)
    |--- updateSoul        (modify personality)
    |--- updateUserProfile (update user info)
    |--- ...               (channel-specific and skill-specific tools)
    '--- spawnTask         (delegate to isolated sub-agent)
              |
              v
         [Sub-Agent] (tier: standard, max 10 steps)
              |--- (all enabled tools except spawnTask)
```

The set of tools available to a given agent is determined by the rows enabled in the `agent_tools` table. Sub-agents inherit those tools **except** `spawnTask`, to prevent infinite recursion.

---

## Supervisor

**File**: `packages/engine/src/agents/supervisor/index.ts`

The Supervisor is the system's decision-making center.

| Setting | Value |
|---------|-------|
| Tier | `standard` (per-instance configurable) |
| Max steps | 15 |
| System prompt | Built dynamically in `packages/engine/src/agents/supervisor/prompt.ts` from per-instance configuration |

The system prompt is assembled from 8 modular sections stored in the `agent_prompts` PostgreSQL table (one row per `(agentId, sectionKey)`). Defaults for new agents live in `packages/engine/src/instances/defaults.ts` and are seeded on agent creation:

- `01-identity` — company/assistant identity
- `02-soul` — personality, tone, values
- `03-tooling` — tool catalog (auto-populated from enabled tools)
- `04-safety` — rules and limits
- `05-skills` — available skills (auto-discovered)
- `06-memory` — memory usage guidelines
- `07-user-identity` — user profile (updated at runtime)
- `08-datetime` — current date/time

Sections can be customized per-agent from the admin panel (`PATCH /api/agents/:slug/prompts`) or directly in the database. The Supervisor reads them via `getPrompts(agentId)` from `prompts.store.ts` (60s TTL cache).

Available tools are filtered per-agent via the `agent_tools` table (auto-recomputed when skills change). Tool registration is automatic at boot: every `*.tool.ts` file in `packages/engine/src/agents/tools/` calls `registerTool()` and the supervisor queries `getToolRegistry()` — no hardcoded tool imports.

### Sync and Streaming

- `supervise()` returns the full response after all reasoning steps complete.
- `superviseStream()` returns an `AsyncIterable<string>` for SSE streaming.

Both entry points accept an optional `AbortSignal` that is propagated end-to-end through the AI gateway (`chat`/`chatStream`) down to the Vercel AI SDK call, so an in-flight Supervisor run can be cancelled (used by the inbound message coordinator to collapse fragment bursts on WhatsApp/Telegram).

### Reasoning and Step Capture

Each Supervisor step (one LLM call within a multi-step reasoning loop) is buffered by the AI gateway and surfaced on the response. `ChatResponse.steps` is an array of `{ text, reasoningBlocks, toolCalls }` — letting downstream code persist per-step traces (Anthropic-style `<thinking>` blocks, tool invocations with arguments, intermediate assistant text). This replaces the older shallow `tool_calls` array.

The conversation messages schema was migrated accordingly (migration `0038_reasoning_and_steps.sql`): the `tool_calls` column was renamed to `steps` and a new `reasoning` column was added. See `packages/engine/src/ai-gateway/` and `packages/engine/src/conversations/conversations.schema.ts`.

---

## Tools

All tools are defined in `packages/engine/src/agents/tools/` as self-registering `*.tool.ts` files. To add a new tool, create a new file that calls `registerTool()` — the registry picks it up at boot and the `tools` DB table is synced automatically. Per-agent enablement is then controlled via `agent_tools`.

The list of tools shipped with Polyant changes over time; consult the source directory for the current set. A few categories that are part of the framework:

- **Memory** — `searchMemory`, `saveMemory`
- **Knowledge** — `searchKnowledge`, `getKnowledge`, `writeKnowledge`
- **Skills** — `createSkill`, `readSkill`, `runSkillScript`
- **Web** — `webSearch`, `httpRequest`, `curl`
- **Identity** — `updateSoul`, `updateUserProfile`
- **Delegation** — `spawnTask`
- **Channel-specific** — outbound messaging, template sending, Slack/WhatsApp/Telegram-specific helpers
- **Integration** — examples include HubSpot CRM, GitHub, Render, generic file/document operations

Each tool is documented inline in its `*.tool.ts` file via the Zod `description` field.

---

## Sub-Agent System

**Files**: `packages/engine/src/agents/tools/task-tool.ts` (the `spawnTask` tool), `packages/engine/src/agents/sub-agents/types.ts` (the `SubAgentDefinition` interface).

### `spawnTask` — ad-hoc sub-agents

`spawnTask` is the meta-tool the Supervisor uses to delegate a focused unit of work to an isolated sub-agent. The sub-agent runs with the same tier (`standard`), a generic delegation system prompt, and inherits every tool the Supervisor has — **except** `spawnTask` itself.

**Recursion guard (commit `5b1b3a3d`)**: the sub-agent's tools dict is built by destructuring `spawnTask` out of the parent's snapshot, and the system prompt explicitly tells the sub-agent that `spawnTask` is unavailable. The Supervisor builds `spawnTask` last and passes a point-in-time snapshot (`{ ...tools }`) to the factory, so `ask_*` agent-to-agent handoffs (built earlier) remain visible to the sub-agent while `spawnTask` does not. Effective max delegation depth is therefore **1** — a sub-agent cannot recursively spawn another sub-agent.

### `SubAgentDefinition` — future specialised agents

The `SubAgentDefinition` interface in `packages/engine/src/agents/sub-agents/types.ts` is the contract for future specialised sub-agents. It is not used by `spawnTask`'s ad-hoc path (which composes the sub on the fly); it exists as a hook so a future registry-based routing mechanism can pick a typed, named agent instead of building one generically.

### Extending the Sub-Agent System

To add specialized sub-agents, you would need to:

1. Implement a registry or routing mechanism in the spawn-task implementation.
2. Define agents conforming to `SubAgentDefinition`:

```typescript
import { tool } from "ai";
import { z } from "zod";
import type { SubAgentDefinition } from "../types.js";

const agent: SubAgentDefinition = {
  name: "my-agent",
  description: "What this agent does (shown to Supervisor for routing)",
  systemPrompt: "You are a specialized agent that...",
  defaultTier: "standard",
  maxSteps: 10,
  tools: {
    myCustomTool: tool({
      description: "What this tool does",
      parameters: z.object({ input: z.string() }),
      execute: async ({ input }) => {
        return { result: `Processed: ${input}` };
      },
    }),
  },
};

export default agent;
```

### SubAgentDefinition Interface

```typescript
interface SubAgentDefinition {
  name: string;              // Unique identifier
  description: string;       // Human-readable, used by Supervisor for routing
  systemPrompt: string;      // System prompt for the sub-agent
  tools: Record<string, Tool>; // Agent-specific tools
  defaultTier: ModelTier;    // "fast" | "standard" | "heavy"
  maxSteps?: number;         // Max reasoning steps (default: 10)
}
```

---

## Agent-to-Agent Virtual Channel

**Files**: `packages/engine/src/channels/adapters/agent.adapter.ts`, `packages/engine/src/agents/tools/agent-invoke.helpers.ts`.

When an instance has the `agent` channel enabled, every **other** instance with the `agent` channel enabled is exposed to the Supervisor as a synthesized tool named `ask_<callee-slug>`. Calling that tool runs the callee's Supervisor in-process (no HTTP, no socket) with the caller's prompt as a one-shot message, and returns the textual response.

Two safety properties:

- **Depth is bounded at 1.** A callee invoked via `ask_*` is itself running with `agent`-channel context that strips its own `ask_*` synthesis — so it cannot delegate further to a third instance.
- **Each call is wrapped in a per-call timeout** controlled by `AGENT_CALL_TIMEOUT_MS` (default `60_000` ms). The pending request is aborted on expiry and the tool returns a structured timeout error to the caller's Supervisor.

The set of `ask_*` tools is built once per supervisor run, snapshotted before `spawnTask` is appended, so handoffs survive the recursion guard described above.

---

## Memory Integration

Agents interact with memory through two mechanisms:

### During Conversation (via tools)
- `searchMemory` — proactive hybrid search for relevant context.
- `saveMemory` — explicit save on user request.

### After Response (automatic, fire-and-forget)
After each Supervisor response, the system automatically:
1. Saves the conversation messages to PostgreSQL.
2. Generates an updated conversation summary (tier: fast).
3. Extracts memories via LLM (tier: fast) → generates embeddings (OpenAI) → upserts to pgvector with cosine similarity deduplication.

Memory extraction is conditional on the agent's `memoryEnabled` flag. The extraction prompt includes today's date and converts relative dates to absolute (e.g. "tomorrow" → concrete date). Facts are written in the same language as the conversation.

This happens asynchronously and does not block the user response. See `packages/engine/src/memory/extractor.ts` for the extraction logic.
