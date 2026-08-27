# AGENTS.md

Polyant is a framework for building AI assistants: a multi-agent runtime
(`packages/engine`, NestJS) plus an administration panel (`packages/web`, Next.js), in an
npm workspaces monorepo. It is deliberately domain-agnostic — an assistant's behaviour comes
entirely from per-instance data held in PostgreSQL (prompts, skills, tool enablement,
secrets, channels), never from code branches, so one deployment hosts unrelated assistants.

## Read CLAUDE.md

**[CLAUDE.md](CLAUDE.md) is the single source of truth** for how this repository works:
commands, layout, the agent pipeline, tool and hook authoring, tenancy and RBAC, and the
traps that are not inferable from the code. This file exists because `AGENTS.md` is a
convention several coding agents look for — it is a pointer, not a second description. It
held a full description once, and it drifted several major versions behind: it described
Vercel AI SDK v4, prompts and a tool catalogue as files on disk, and tools that no longer
exist. A fact recorded in two places is a fact that will disagree with itself.

Further reference, in the order you are likely to need it:

| Topic | Where |
|---|---|
| Rules, conventions, traps | [CLAUDE.md](CLAUDE.md) |
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |
| Backend patterns, design system | `.claude/skills/backend-architecture/`, `.claude/skills/frontend-design-system/` |
| Authoring a tool or a hook, loading a plugin | [docs/plugins.md](docs/plugins.md), `.claude/skills/plugin-authoring/` |
| Design records for individual features | `docs/superpowers/specs/`, `docs/superpowers/plans/` |
| Architecture decisions | [docs/adr/](docs/adr/) |
| Contributing, security policy | [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) |

Project rules under `.claude/rules/` are enforced constraints, not suggestions — coding
style, security, testing, git workflow, TypeScript conventions.

## Releases

Before preparing, promoting, tagging, or publishing a release, load
`.claude/skills/release/SKILL.md`. Never create a release through ad-hoc Git/GitHub
commands, force-push protected branches, or retarget a published tag.
