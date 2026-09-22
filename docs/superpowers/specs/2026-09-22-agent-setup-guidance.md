# Agent setup guidance

**Date:** 2026-09-22
**Status:** implemented

## Outcome

New agents do not activate Memory or speech-to-text before an operator requests
them. Configuration screens point to missing credentials using the readiness
checks already shown on the agent Status page.

## Decisions

- Change only database defaults for newly inserted agents: Memory defaults off
  and STT defaults to `disabled`. Existing rows and explicit import values stay
  unchanged.
- Keep provider and model overrides nullable, but expose `effectiveProvider` and
  `effectiveModel` in the management API so clients can show the runtime fallback.
- Keep the OSS readiness rules client-side. The agent page runs them once and
  shares their result with Status, model/audio settings, and tool assignment.
- Missing credentials remain advisory. Saves are not blocked because credentials
  can be configured before or after the capability.
- Do not flag Bedrock/AWS without stored keys: host IAM or profile credentials may
  satisfy the runtime.

## Verification

- Schema and migration tests pin the new defaults and prohibit data rewrites.
- The create-path integration test checks the defaults against PostgreSQL.
- Import tests pin preservation of explicit bundle values.
- Controller and readiness tests cover the effective model fallback and missing
  provider/STT credentials.
- Page tests prove one readiness result is shared with each configuration section.
