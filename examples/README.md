# Examples

This directory contains minimal, working examples you can copy into your own Polyant deployment.

## Structure

```
examples/
├── instances/             # Example instance configurations
│   └── hello-world/       # Bare-minimum assistant
│       ├── instance.json     # Instance metadata
│       └── prompts/          # 8 system prompt sections
├── skills/                # Reusable skill definitions
│   └── weather/           # Skill with an API-key env var
│       └── SKILL.md
├── tools/                 # Example custom tools
│   └── echo.tool.ts       # The simplest possible tool
├── generic-assistant/     # Use case: vendor-neutral general assistant
│   └── README.md
└── helpdesk-agent/        # Use case: internal FAQ helpdesk on Slack
    └── README.md
```

## Available use cases

- [generic-assistant](./generic-assistant/) — Vendor-neutral assistant for
  general-purpose conversations, drafting, and personal productivity.
- [helpdesk-agent](./helpdesk-agent/) — Internal FAQ helpdesk that searches a
  knowledge base and escalates unresolved questions to Slack.

## How to use

These are **reference examples**, not runnable scripts. To use one:

### An instance

1. Create the instance through the admin panel (or `POST /api/instances`).
2. Copy the prompt sections from `examples/instances/hello-world/prompts/*.md` into the admin panel's **Prompts** tab.
3. Copy `instance.json` values (description, provider, model) into the **Settings** tab.

### A skill

1. Go to the admin panel's **Skills library** (or `POST /api/skills`).
2. Create a new skill; paste the content of `SKILL.md` into the body.
3. Enable the skill on your instance via the **Skills** tab; provide any required env vars.

### A tool

1. Copy the `.tool.ts` file into `packages/engine/src/agents/tools/`.
2. Restart the engine — the tool auto-registers on boot.
3. Enable it on your instance via the **Tools** tab.

See [Quickstart](https://docs.polyant.ai/getting-started/quickstart) for an end-to-end walkthrough.

## Bootstrap

If you just want to try Polyant quickly, the project ships a `demo-agent`
instance created automatically at first boot by the database seed migration.
See the **Quickstart with demo-agent** section in
[Quickstart](https://docs.polyant.ai/getting-started/quickstart).
