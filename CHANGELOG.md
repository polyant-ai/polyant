# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-08-25

### Added

- WhatsApp channels can authenticate to Twilio with a revocable API Key instead of the account Auth Token. Twilio signs inbound webhooks with the Auth Token only, so an API Key channel receives messages on a dedicated webhook URL carrying a server-generated secret, which can be revealed and rotated from the admin panel.
- The WhatsApp channel has its own configuration card in the admin panel, with a credential-mode selector and the webhook URL to paste into the Twilio Console.

### Changed

- Channel configuration is persisted exactly as its schema validates it, so credentials pasted with surrounding whitespace are trimmed and keys outside the validated shape are no longer stored.
- The management API writes only known channel configuration keys and ignores unrecognised fields in a request body.
- Twilio Account SIDs are validated for format when a WhatsApp channel is saved.

### Security

- Webhook paths that carry a credential are redacted before being written to logs, covering both the WhatsApp inbound webhook secret and the Room event-source webhook token.
- Inbound WhatsApp webhook requests that fail before authentication all return one identical response, so an anonymous caller cannot enumerate agent slugs or determine which credential mode a channel uses.
- Request-controlled values are stripped of line breaks before being written to a log line, so they cannot introduce additional log records.

## [1.0.0] - 2026-08-05

### Added

- First public open-source release of Polyant, with a Supervisor runtime for configurable AI assistants, automatic long-term memory, and multi-channel delivery.
- Telegram, Slack, WhatsApp, webhooks, and an OpenAI-compatible HTTP API, alongside multi-instance administration and conversation inspection.
- Encrypted per-instance secrets, plugins and Markdown skills, Room automation, and runtime analytics.
- Bounded agent-to-agent handoffs, live activity, configurable web search, and structured tool-secret inputs.

### Changed

- Semantic Versioning now defines the public compatibility contract for the documented OpenAI-compatible API, Plugin SDK and manifest, and documented configuration and migration behavior.
- Conversation traces preserve per-step reasoning and tool metadata; incoming message fragments can safely cancel and restart an in-flight run.

### Fixed

- Memory deduplication now honors its configured similarity threshold, and Google OAuth remains optional when its credentials are absent.
- Delegated sub-agents cannot recursively spawn further sub-agents.
- Node.js 22 is aligned across the supported development and container environments.

[Unreleased]: https://github.com/polyant-ai/polyant/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/polyant-ai/polyant/releases/tag/v1.0.1
[1.0.0]: https://github.com/polyant-ai/polyant/releases/tag/v1.0.0
