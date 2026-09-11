---
paths:
  - "**/*.test.{ts,tsx,js,mjs}"
  - "**/*.integration.test.ts"
  - "packages/web/e2e/**/*.ts"
  - "**/vitest.config.*"
---

# Tests

- Name the observable break the test catches. Test public behaviour, not source text or
  private structure.
- Derive expected values independently; do not call production helpers to build both sides
  of an assertion.
- Mock only slow or external boundaries. Prefer real internal collaborators and complete,
  realistic fixtures.
- A codebase guardrail discovers its subjects from the repository and asserts a non-empty
  input set when emptiness would make it vacuous.
- Do not invent coverage thresholds in prose. The Vitest configuration and CI are the
  executable authority.
- Classify a failure before changing code or assertions: regression, outdated expectation,
  flake, assertion mismatch, or environment problem.
