# Security Policy

## Supported Versions

Polyant is under active development. Security fixes are applied to the `main` branch and to the latest tagged release. Older releases are not maintained.

| Version     | Supported |
|-------------|-----------|
| `main`      | yes       |
| latest tag  | yes       |
| older tags  | no        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue to report a security vulnerability.**

Instead, use GitHub's private vulnerability reporting feature:

1. Go to the repository's **Security** tab on GitHub.
2. Click **Report a vulnerability**.
3. Fill in the details (steps to reproduce, affected version, impact).

If GitHub's private reporting is not available, email `security@polyant.ai` with:

- A clear description of the issue
- Steps to reproduce
- Affected version/commit
- Your assessment of severity and impact

### What to expect

- We acknowledge reports within **48 hours**.
- We aim to triage and confirm within **7 days**.
- We target a fix within **30 days** for high-severity issues; lower-severity issues may take longer.
- We will coordinate disclosure with you: we generally prefer **90 days** between report and public disclosure, but we are flexible.
- We credit reporters in the release notes unless you prefer to stay anonymous.

### Scope

The following are **in scope**:

- Authentication / authorization bypass in the admin panel or management API
- SQL injection, command injection, path traversal, SSRF
- Secret exposure (encrypted storage, tokens, keys)
- RCE via tool execution (e.g. `gitCloneRepo`, `claudeCode`, `httpRequest`)
- XSS / CSRF in the admin panel
- Cryptographic weaknesses in the AES-256-GCM secret-storage layer
- Prompt-injection vulnerabilities that lead to privilege escalation or data exfiltration across instances

The following are **out of scope**:

- Attacks that require a malicious instance configuration (instance admins can set arbitrary prompts and enable tools — this is by design)
- Denial-of-service from cost-blowing LLM calls (mitigated by per-instance rate limits and cost tracking, but not a hard guarantee)
- Issues in third-party dependencies that do not affect Polyant's own code paths (report those upstream)
- Self-hosted deployment misconfiguration (weak `AUTH_SECRET`, missing HTTPS, etc.)

## Hardening Checklist

If you run Polyant in production, please review:

- [ ] Strong randomly-generated `ENCRYPTION_KEY` (32 bytes, hex-encoded) — lost key = lost instance secrets
- [ ] Strong randomly-generated `AUTH_SECRET` — rotating this invalidates all existing sessions
- [ ] `AUTH_TRUST_HOST=true` only when behind a trusted reverse proxy
- [ ] `AUTH_ALLOWED_DOMAIN` set to restrict sign-in to your organization's domain (legacy `AUTH_ALLOWED_DOMAINS` still honoured)
- [ ] PostgreSQL not exposed to the public internet
- [ ] HTTPS terminated at the edge (Render / Fly.io / Cloudflare / your reverse proxy)
- [ ] Regular `npm audit` on the lockfile; Dependabot enabled
- [ ] Backups of the PostgreSQL database (memories, conversations, and encrypted secrets are stored here)

## Thanks

We appreciate the security community's efforts to keep Polyant safe. Thank you for reporting responsibly.
