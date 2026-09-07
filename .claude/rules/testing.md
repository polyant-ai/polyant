---
description: "Enforce testing standards: coverage, classification, and structure"
globs: ["**/*.test.*", "**/*.spec.*", "**/test_*.py", "**/*_test.py", "**/*_test.go"]
alwaysApply: true
---

# Testing Rules

## MUST (violations block PR)

### Coverage
- Minimum coverage target: 80% for new code
- Every PR adding business logic MUST include tests
- Critical paths (auth, payments, data mutation) MUST have 100% coverage

### Failure Classification
- Every test failure MUST be classified as: **REGRESSION**, **TEST OUTDATED**, **FLAKY**, or **ASSERTION MISMATCH**
- Never assume all failures are regressions — verify with `git log` on the involved files
- Before updating an assertion: VERIFY the behavior change was intentional

**Detailed taxonomy**:

| Type | Signal | Action |
|------|--------|--------|
| **REGRESSION** | Test passed before the change, fails now | Fix the code, not the test |
| **TEST OUTDATED** | Behavior changed intentionally | Update test to match new spec |
| **FLAKY** | Passes/fails without code changes | Quarantine, track, fix timing/deps |
| **ASSERTION MISMATCH** | Expected value wrong, logic correct | Verify spec, then update assertion |
| **ENVIRONMENT** | Works locally, fails in CI | Check deps, env vars, OS differences |

### Confidence Rule
- Reporting a test failure as "fixed" requires ≥80% confidence the fix is correct
- If confidence <80%: state the uncertainty and propose verification steps

### Structure
- Tests MUST include a `file:line` reference for every failure
- Group failures by module/package to spot patterns
- Every test MUST test ONE thing (single assertion per concept, not per line)

### Guardrail tests

A guardrail test asserts a property of the WHOLE codebase, not of one unit. Two
rules, both learned the hard way, and neither previously written down:

- **Derive the subject list from the code, never from a hand-kept array.**
  `server/route-authorization-guardrail.test.ts` walks the NestJS module graph;
  `agents/tools/strict-mode.test.ts` iterates the live registry;
  `database/migration-journal.test.ts` globs the directory in both directions.
  A hand-maintained list is a list a new file silently escapes — the guard stays
  green precisely when it should have caught something.
- **Assert a non-vacuity floor.** A guardrail whose input set is empty passes.
  `strict-mode.test.ts` has `expect(checked, "no tools were checked — registry
  empty?").toBeGreaterThan(0)`; the route guardrail has `controllers.length > 20`.
  Without a floor, a broken loader or a changed glob turns the guard into a
  no-op and nothing says so.

Counter-example in the tree: the panel's `status-checks.test.ts` "every check"
test derives its subjects from ONE crafted input rather than the catalogue, so a
check whose trigger that fixture does not satisfy escapes the rule entirely.

### Flaky Tests
- Flaky tests MUST be flagged and tracked — they mask real regressions
- Patterns to watch for: timing dependencies, execution order, external resources

## SHOULD (warnings)

- Arrange-Act-Assert (AAA) pattern for every test
- Test name: `should_[expected]_when_[condition]` or the framework equivalent
- Mock only external dependencies (API, DB) — never mock the code under test
- Integration test for every critical API endpoint
- Cover edge cases: null/undefined, empty collections, boundary values
