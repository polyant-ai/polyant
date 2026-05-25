# Glossary

Quick reference for the core Polyant vocabulary. For long-form definitions
with examples, see [Glossary](https://docs.polyant.ai/concepts/glossary).

- **Instance** — A shared assistant configuration (prompts, tools, skills,
  secrets, channels). Multiple users interact with the same instance.
- **Skill** — A reusable prompt-and-tool bundle (Markdown frontmatter + body).
  Stored in the global skill library, attached to instances on demand.
- **Tool** — A self-registering function callable by the LLM (`*.tool.ts`).
  Auto-discovered at boot.
- **Channel** — Inbound/outbound message transport (Telegram, Slack,
  WhatsApp, web).
- **Room** — Event-driven workspace where the agent acts proactively in
  response to external events.
- **Event Source** — A webhook endpoint that converts external events
  (HubSpot, GitHub, etc.) into Room actions.
- **Pipeline** — End-to-end message processing: input → context →
  governance → LLM → tools → governance → output.
- **Supervisor** — The central LLM call that orchestrates tools and produces
  the response.
- **Sub-agent** — An LLM invocation spawned by `spawnTask` for delegated
  reasoning.
- **AI Gateway** — Provider-agnostic LLM abstraction. Components request a
  tier (`fast` / `standard` / `heavy`); mapping in `ai-gateway/config.ts`.
- **Memory** — pgvector + FTS storage of extracted facts, with
  cosine-similarity dedup.
- **Tier** — A tag (`fast` / `standard` / `heavy`) that maps to a concrete
  model. Lets components stay model-agnostic.
- **Governance** — Pluggable input/output policy layer (gates, audit) that
  runs before and after the LLM call.
- **Workspace** — Per-instance, per-conversation scratch directory used by
  filesystem-backed tools. Ephemeral (cleaned after 2 hours).
