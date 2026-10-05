---
paths:
  - "**/*.test.{ts,tsx,js,mjs}"
  - "**/*.integration.test.ts"
  - "packages/web/e2e/**/*.ts"
  - "**/vitest.config.*"
---

# Tests

Tests protect important behavior and challenge the code while allowing different correct
implementations. Add a test for a concrete regression, boundary, compatibility contract,
or plausible failure; a normal success case is useful when it protects meaningful behavior.
Choose relevant edge cases: missing/inconsistent data, limits, dependency failures,
cancellation, concurrency or partial results. Each test must have three answers:

- Which significant error does it catch?
- Which incorrect change would make it fail?
- Would a different correct implementation still pass?

Derive expectations from the requirement independently of production logic. Test observable
behavior; use structural guardrails only for an explicit architectural/distribution contract,
not incidental source wording. Discover guardrail subjects and assert non-vacuity.
Mock slow/external boundaries; exercise real internal collaborators and realistic fixtures.
For fallback/cache/hybrid paths, use inputs the alternative cannot satisfy and demonstrate
the regression by disabling only the path under examination.

TDD is welcome: observe the intended failure before implementing behavior. At the final
checkpoint, retain meaningful regression proof and simplify redundant or implementation-bound
tests; exploratory checks may be temporary. Behavior-preserving refactors should keep tests
green; intentional contract changes update expectations and affected consumers together.
Do not remove useful regressions or loosen assertions just to make a failure disappear.
Classify failures first: regression, outdated expectation, flake, assertion mismatch or
an environment problem. Snapshots must have a reviewable contract, not blanket approval.

Choose tests by risk rather than one per function or a coverage target. Coverage alone is
not quality; its configured thresholds remain authoritative. Apply this review once to
changed tests within the existing checkpoint, without a separate suite or evidence field.
