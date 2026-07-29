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
- First-party MCP server support for tools.
- Complete multi-tenancy: the `Organization > Workspace > Agent` schema, RBAC,
  and tenant-scoped frontend URLs are in place, but organization/workspace CRUD,
  a workspace switcher, an invitation flow, a default role below Owner, and
  making the workspace URL segment authoritative are still missing — and
  enforcement ships in shadow mode (`AUTHZ_ENFORCE` opt-in).

## Future

- Voice channel (STT/TTS pipeline).
- Plugin marketplace for skills.

## Out of scope

- Hosting/SaaS offering — Polyant is self-hosted by design.

## Get involved

File an issue, join discussions, or open a PR. See
[CONTRIBUTING.md](./CONTRIBUTING.md).
