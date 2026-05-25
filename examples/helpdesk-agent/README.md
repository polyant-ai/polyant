# Helpdesk Agent

An internal helpdesk-style assistant that answers FAQs against a company
knowledge base and forwards unresolved questions to a Slack channel.

This is a **documentation-only example**. It describes a recommended prompt,
tool, channel, and skill layout for a helpdesk use case. To use it, create an
instance via the admin panel (or `POST /api/instances`) and copy the relevant
fields.

## Use case

Employees ask the agent questions about internal processes (HR policies, IT
procedures, onboarding steps). The agent searches the knowledge base, returns a
grounded answer with sources, and posts unresolved questions to a Slack
channel for the human helpdesk team.

## Suggested prompt sections

### `01-identity`

```markdown
# Identity

You are the internal helpdesk assistant for our company. You answer questions
about HR, IT, and internal processes by searching the company knowledge base.
When you cannot find a confident answer, you escalate to the human helpdesk.
```

### `02-soul`

Override the default tone:

```markdown
## Tone and Style
- Professional, neutral, factual. No casual language.
- Always cite the source document title when answering from the knowledge base.
- If you are not confident, say so and escalate.
```

### `03-tooling`

Add an explicit escalation rule:

```markdown
## Escalation
If the knowledge base does not contain a confident answer, post the user's
question to the helpdesk Slack channel using `slackPostMessage` and tell the
user that a human will follow up.
```

### `04-safety`

Keep defaults. Add a privacy reminder:

```markdown
## Privacy
- Never echo back PII (employee IDs, salaries, contracts) without verifying
  the requester is the rightful owner of the data.
```

## Recommended tools

| Tool                | Purpose                                                  |
|---------------------|----------------------------------------------------------|
| `searchMemory`      | Recall what previous users asked about the same topic    |
| `saveMemory`        | Persist FAQ patterns the agent has learned               |
| `slackPostMessage`  | Escalate unresolved tickets to the helpdesk channel      |
| `readSkill`         | Load a domain-specific skill (e.g. onboarding playbook)  |
| `spawnTask`         | Delegate multi-step research across multiple documents   |

## Channels

- **Slack** — primary inbound + outbound channel. Configure the bot token in
  the admin panel under **Channels → Slack**.
- **Web (Playground)** — for testing answers before going live.

## Skills

A real deployment would attach a knowledge-management skill (for example
`kb-search` — not shipped in this repo) that wraps your retrieval backend
(Notion, Confluence, GitHub Wiki, etc.). See `examples/skills/weather/` for the
skill file format.

If `knowledgeEnabled` is on, the built-in knowledge tooling can be used instead
of a custom skill.

## Settings

| Setting              | Recommended value                                 |
|----------------------|---------------------------------------------------|
| `memoryEnabled`      | `true`                                            |
| `knowledgeEnabled`   | `true` — surfaces uploaded knowledge documents    |
| `authEnabled`        | `true` in production (employees only)             |
| `langsmithEnabled`   | optional                                          |

See [Quickstart](https://docs.polyant.ai/getting-started/quickstart) for the
end-to-end setup walkthrough and
[Connect a Channel](https://docs.polyant.ai/getting-started/connect-a-channel) for the Slack channel
configuration.
