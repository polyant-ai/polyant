---
description: "Enforce OWASP Top 10 security practices across all projects"
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
alwaysApply: true
---

# Security Rules

## MUST (violations block PR)

### Input Validation
- ALL user input MUST be validated and sanitized before use
- Never trust client-side data: always validate on the server
- Use Zod schema validation — never manual `if`-based validation

### Injection Prevention
- SQL: ALWAYS parametrized queries or ORM. Never string concatenation for queries.
- XSS: ALWAYS escape HTML output. Use templating frameworks (React JSX, Jinja2 autoescaping).
- Command Injection: never pass user input to `exec()`, `eval()`, `os.system()`, `child_process.exec()`

### Authentication & Authorization
- Every sensitive endpoint MUST have an authentication check
- Permission checks MUST live at endpoint level (middleware/dependency), never inline in business logic
- Token/session validation MUST happen before any operation

### Data Exposure
- Never expose stack traces, SQL queries, or internal paths in API responses
- Response objects MUST use explicit DTO/schema — never return the DB model directly
- Logging MUST mask sensitive data (passwords, tokens, PII)

### Secrets Management
- Credentials MUST come from environment variables or a secret manager
- `.env` files MUST be in `.gitignore`
- Never commit: API keys, passwords, connection strings, private certificates

### CSRF & CORS
- CORS: configure `allowed_origins` explicitly. Never `*` in production.
- CSRF: form mutations MUST have a CSRF token (unless an SPA using JWT)

### Security Incident Escalation
When a vulnerability or leak is detected:

1. **HALT** — Stop immediately. Do not continue the implementation.
2. **ESCALATE** — Notify the team. Classify severity:
   - **P0 (Critical)**: Secret leaked in repo, SQL injection in production, auth bypass
   - **P1 (High)**: Possible XSS, permission escalation, missing auth check
   - **P2 (Medium)**: Missing rate limit, verbose error messages, missing CORS config
3. **AUDIT** — Verify the blast radius: which systems/data are exposed?
4. **ROTATE** — If credentials leaked: immediately rotate ALL exposed credentials, not just the ones found.

## SHOULD (warnings)

- Rate limiting on authentication endpoints
- Periodic dependency audits (`npm audit`, `pip audit`, `safety check`)
- Security headers: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`
- Least privilege: service accounts with the minimum permissions required
- Security review required for: auth changes, payment logic, PII handling, permission changes
