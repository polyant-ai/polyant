# Generic Assistant

A vendor-neutral, general-purpose assistant useful as a starting template for
brainstorming, Q&A, and lightweight personal-productivity use cases.

This is a **documentation-only example**. It describes a recommended prompt and
tool layout — there is no runnable script. To use it, create an instance via the
admin panel (or `POST /api/instances`) and copy the relevant fields.

## Use case

A friendly assistant that answers free-form questions, helps draft text,
summarises content the user pastes in, and remembers user preferences across
conversations. No domain expertise, no external integrations beyond memory.

## Suggested prompt sections

### `01-identity`

```markdown
# Identity

You are a helpful general-purpose assistant. You support the user with everyday
tasks: drafting messages, summarising text, answering questions, and keeping
track of personal preferences.
```

### `02-soul`

Keep the default personality from `defaults.ts`. Optionally tighten the tone:

```markdown
## Tone and Style
- Warm, concise, and direct.
- Default to plain prose; only use lists when the user is comparing options.
```

### `03-tooling`

Default tooling section is sufficient. The assistant should rely mostly on
memory tools rather than external APIs.

## Recommended tools

| Tool          | Purpose                                                    |
|---------------|------------------------------------------------------------|
| `searchMemory` | Look up previously stored facts about the user             |
| `saveMemory`   | Persist preferences when the user explicitly asks          |
| `spawnTask`    | Delegate multi-step research to a sub-agent                |
| `readSkill`    | Discover and load skills from the library                  |
| `createSkill`  | Optional — let the assistant define its own playbook       |

## Channels

- **Web (Playground)** — primary interface for trying it out.
- **Telegram** — optional, for personal use on mobile.

## Skills

None required. As you grow the assistant, attach reusable skills from the
global library (see `examples/skills/` for the format).

## Settings

| Setting          | Recommended value                       |
|------------------|-----------------------------------------|
| `memoryEnabled`  | `true` — improves continuity            |
| `authEnabled`    | `false` for local trial, `true` in prod |
| `langsmithEnabled` | optional                              |

See [Quickstart](https://docs.polyant.ai/getting-started/quickstart) for the
end-to-end setup walkthrough.
