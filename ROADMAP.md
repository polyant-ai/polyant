# Roadmap

Polyant is a community-driven open-source project. This roadmap is
**non-binding** and reflects current direction; priorities can shift based on
contributions and feedback.

## Now

- Stabilize the public OSS release.
- Expand documentation (architecture, tutorials, examples).
- Improve test coverage on integration paths.

## Next

- More channel adapters (Discord, Microsoft Teams).
- Model Context Protocol: consume tools from external MCP servers, and expose
  Polyant's own tools as an MCP server.
- Agent2Agent (A2A) protocol support.
- Complete multi-tenancy: the `Organization > Workspace > Instance` schema and
  the RBAC role/permission model are in place, but enforcement is opt-in
  (`AUTHZ_ENFORCE`), and organization/workspace CRUD and an email-invitation
  flow are still missing.

## Future

- Bidirectional voice channel: inbound audio is already transcribed per instance
  (Whisper / Amazon Transcribe / Deepgram); what is missing is TTS and a realtime
  transport.
- Plugin marketplace for skills.

## Out of scope

- Hosting/SaaS offering — Polyant is self-hosted by design.

## Get involved

File an issue, join discussions, or open a PR. See
[CONTRIBUTING.md](./CONTRIBUTING.md).
