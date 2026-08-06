# Roadmap

Polyant is a community-driven open-source project. This roadmap is
**non-binding** and reflects current direction; priorities can shift based on
contributions and feedback.

## Now

- Stabilize the public OSS release.
- Expand documentation (architecture, tutorials, examples).
- Improve test coverage on integration paths.

## Next

- Web search tool (Tavily / Brave Search wrappers).
- More channel adapters (Discord, Microsoft Teams).
- Expose Polyant's own tools as an MCP **server**, so an external client can
  consume them. The client side has shipped — an agent can already equip tools
  from external MCP servers (`none` / `static` / OAuth 2.1 auth, per agent).
- A2A **client** (outbound): an agent calling another agent over the Agent2Agent
  protocol. The server side has shipped — an agent can already be exposed as an
  A2A agent (opt-in per agent, off by default).
- Complete multi-tenancy: the `Organization > Workspace > Agent` schema, RBAC
  (enforced unconditionally — there is no shadow mode), tenant-scoped frontend
  URLs and an authoritative workspace URL segment are in place. Still missing:
  organization/workspace CRUD, a workspace switcher, and an email-invitation flow
  — today an administrator creates the user and then assigns them a role, which
  works but is two manual steps.

## Future

- Voice channel (STT/TTS pipeline).
- Plugin marketplace for skills.

## Out of scope

- Hosting/SaaS offering — Polyant is self-hosted by design.

## Get involved

File an issue, join discussions, or open a PR. See
[CONTRIBUTING.md](./CONTRIBUTING.md).
