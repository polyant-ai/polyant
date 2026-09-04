# Glossary

Quick reference for the core Polyant vocabulary. For long-form definitions
with examples, see [Glossary](https://docs.polyant.ai/concepts/glossary).

- **Instance** (also **Agent**) — A shared assistant configuration (prompts,
  tools, skills, secrets, channels). Multiple users interact with the same one.
  `instance` is the identifier used throughout the code and the API; `agent` is
  the word the admin panel shows.
- **Organization** — Top tenancy level. Owns workspaces and memberships.
- **Workspace** — Tenancy level between organization and agent: every agent
  belongs to exactly one workspace. Not to be confused with the
  per-conversation *sandbox* directory below, or with npm workspaces.
- **Role** — One of `owner`, `admin`, `member`, `viewer`: a named set of
  `resource:action` permissions, bound to a user within an organization.
- **Skill** — A reusable prompt-and-tool bundle (Markdown frontmatter + body).
  Stored in the global skill library, attached to instances on demand.
- **Tool** — A function callable by the LLM, authored as
  `export default defineTool(...)` in a `*.tool.ts` file. Auto-discovered at boot.
- **Plugin** — An external repository of tools loaded at boot via `PLUGIN_DIRS`,
  authored against `@polyant-ai/plugin-sdk` and namespaced (`acme:myTool`).
- **Hook** — A typed code function run by the engine at a fixed point of the
  conversation lifecycle. Never invoked by the LLM.
- **Knowledge base** — Per-agent documents chunked and retrieved with pgvector.
  Distinct from *memory*: knowledge is uploaded, memory is extracted.
- **Channel** — Inbound/outbound message transport (Telegram, Slack,
  WhatsApp, web).
- **Room** — Event-driven workspace where the agent acts proactively in
  response to external events.
- **Event Source** — A webhook endpoint that converts external events
  (HubSpot, GitHub, etc.) into Room actions.
- **Pipeline** — End-to-end message processing: input → context →
  LLM → tools → output.
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
- **Sandbox** — The per-agent, per-conversation scratch directory used by
  filesystem-backed tools, under `workspaces/<instanceId>/conversations/<convId>/`.
  Ephemeral (cleaned after 2 hours). The directory name predates the tenancy
  *Workspace* above; the two are unrelated.
