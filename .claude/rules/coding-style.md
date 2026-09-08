---
description: "Enforce consistent coding style, SOLID principles, and error handling across all projects"
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
alwaysApply: true
---

# Coding Style Rules

## MUST (violations block PR)

- **Single Responsibility**: every file/class/function has ONE responsibility. If the name contains "And", split it.
- **No business logic in controllers/routes**: controllers/routes are HTTP bridges — they delegate to the service layer immediately.
- **No magic strings**: use enums/constants for repeated values. Never hardcode strings for states, types, or configuration.
- **Error handling is mandatory**: every external call (API, DB, file I/O) MUST have explicit error handling.
- **No hardcoded secrets**: credentials, API keys, and connection strings MUST come from environment variables. Never in code.
- **No session/connection leaks**: every opened resource (DB session, file handle, HTTP client) MUST be closed in `finally` or with `using`.
- **DRY**: duplicated code >3 identical lines → extract into a function. Exception: tests (readability wins).
- **Consistent naming**: variables/functions in camelCase, classes in PascalCase, constants in UPPER_SNAKE_CASE. Database columns stay snake_case.

### Immutability First
- Prefer `const`/`readonly` wherever possible. Mutate only when strictly necessary.
- Array/Object: use spread/destructuring to create new instances instead of mutating (`[...arr, item]`, not `arr.push(item)`).

## SHOULD (warnings)

- Prefer composition over inheritance (Dependency Inversion)
- No `console.log` in production code (use a structured logger)
- Prefer early return over deep nesting (`if (!valid) return` > `if (valid) { ... }`)
- Avoid N+1 queries: load relations in batch, not in a loop

### File size
Attention thresholds, not gates: 400 lines per file, 30 per function. Measured today across
906 source files, the median is 111 lines and the 90th percentile 338, so a file past 400 is
outside this repository's norm — but 61 already are, several for good reasons (registries,
catalogues, schemas). Crossing the threshold is a reason to ask whether the file has one
responsibility, not to split it on sight, and never the work of a PR that is doing something
else.

### Pre-Completion Checklist
Before considering the code "done", verify:
- [ ] All critical paths have error handling
- [ ] No hardcoded secrets
- [ ] Inputs validated with a Zod schema
- [ ] Opened resources are closed (DB connections, file handles)
- [ ] Naming consistent with surrounding context
- [ ] No TODOs left without an associated ticket/issue
