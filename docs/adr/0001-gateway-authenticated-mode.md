# ADR-0001: Gateway-Authenticated Mode

- **Status**: Accepted
- **Date**: 2026-04-27
- **Deciders**: @freegenie, @paolovalletta-exelab
- **Related**: PR #92 (initial implementation), issue #115 (JWT signature verification follow-up)

## Context

Agent Builder is a multi-cloud framework. The current AWS deployment template runs the engine behind an Application Load Balancer (ALB) with OIDC authentication enabled, which forwards user identity claims to the upstream service via the `x-amzn-oidc-data` header. Future cloud templates will use analogous mechanisms — none of them are AWS-specific in concept:

| Cloud / gateway       | Identity header                     | Format                                 |
| --------------------- | ----------------------------------- | -------------------------------------- |
| AWS ALB + OIDC        | `x-amzn-oidc-data`                  | JWT signed with ALB regional key       |
| GCP IAP               | `x-goog-iap-jwt-assertion`          | JWT signed with Google IAP key         |
| Cloudflare Access     | `cf-access-jwt-assertion`           | JWT signed with team-specific key      |
| Azure Easy Auth       | `x-ms-client-principal`             | Base64 JSON (not a JWT)                |

The engine needs a single dispatch point that selects between "trust the upstream gateway header" and "validate an Auth.js session cookie" without scattering cloud-specific knowledge throughout the auth code.

## Decision

Introduce a `AUTH_MODE` environment variable as the umbrella dispatch:

- `AUTH_MODE=session` (default) — `auth.guard.ts` validates an Auth.js session JWT (Bearer or cookie). Used for local development and any deployment where the application owns the auth flow.
- `AUTH_MODE=<gateway-name>` (e.g. `alb-oidc`) — `auth.guard.ts` reads the gateway's identity header, parses the claims, and trusts them. The first concrete implementation is `alb-oidc` (`packages/engine/src/auth/alb-oidc.service.ts`).

In a gateway-authenticated mode, **the engine does not verify the JWT signature**. It relies on **network isolation** — specifically, that only traffic routed through the authenticating gateway can reach the engine. On AWS this is enforced by the ECS security group (`agent-builder-ecs-sg-dev` accepts ingress only from the ALB security group).

Adding signature verification is a tracked follow-up (see linked issue) and is expected to be implemented per gateway, because each cloud uses different signing keys and discovery endpoints. The umbrella decision stays the same; only the per-mode parser gains a verify step.

### Web container behaviour

When running behind a gateway-authenticated mode, the `packages/web` (Next.js) container does **not** need `AUTH_SECRET`, `POSTGRES_*`, or `GOOGLE_*` secrets. The Auth.js Edge middleware looks for an `authjs.session-token` cookie that never gets set in this scenario (the gateway uses its own session cookie, e.g. `AWSELBAuthSessionCookie-*` for ALB OIDC). With no cookie to decrypt, Auth.js returns a null session synchronously — no decryption, no `MissingSecret` throw. The user identity used by the engine comes from the gateway header, parsed by the per-mode parser.

This was verified on the AWS deployment at task definition `agent-builder-task-dev:24`, which runs successfully with `AUTH_MODE=alb-oidc` and zero secrets on the web container.

## Consequences

### Positive

- **Pluggable**: adding a new cloud is one new parser file plus one new `AUTH_MODE` value. The guard does not change.
- **Simple operational story**: the engine container has one trust contract per deployment, selected at boot.
- **No duplicate auth**: the web container does not need Auth.js secrets in gateway mode. Less configuration, less rotation surface.
- **Clear separation**: cloud-specific code lives in cloud-specific files. The umbrella concept is documented here, not buried in `auth.guard.ts`.

### Negative

- **Network isolation is the only enforcement**: a misconfigured security group, firewall, or VPC peering that bypasses the gateway is an authentication bypass. The system has no defence-in-depth at the application layer in gateway mode.
- **No revocation through the application**: revoking a user's access requires changes at the gateway (e.g. removing them from the Cognito group). The engine has no concept of "session terminated for user X".
- **Stale knowledge risk**: future maintainers must understand the trust model before changing security-group rules. ECS/VPC changes are now load-bearing for auth correctness.

### Mitigations

- The follow-up issue for JWT signature verification is the planned defence-in-depth measure. It is deferred, not abandoned.
- The engine logs the source of each authenticated request (`source: "alb-oidc" | "session"`) so audit logs can distinguish gateway-trusted requests from session-authenticated ones.
- Inline documentation in `packages/engine/src/auth/alb-oidc.service.ts` states the trust assumption explicitly so it cannot be quietly forgotten during refactors.

## Alternatives Considered

### Verify the gateway JWT signature inline (rejected, deferred)

Use `jose` with the gateway's public key endpoint (for ALB: `https://public-keys.auth.elb.{region}.amazonaws.com/{kid}`) to verify the signature on every request. ~30 LOC per gateway. **Rejected for the initial implementation** because it widens the PR diff during a time-sensitive deployment milestone and because the network-isolation guarantee is genuine (not theatre) for the current AWS topology. **Reopened** as a follow-up issue so the decision is revisited per-gateway.

### Make the web container a full Auth.js participant even behind the gateway (rejected)

Inject `AUTH_SECRET`, `POSTGRES_*`, and `GOOGLE_*` secrets into the web container so Auth.js can also be the source of truth. Belt-and-suspenders. **Rejected** because:
1. It implies that the gateway and the application can disagree about who the user is. Resolving that disagreement is not specified.
2. It adds configuration surface (three secrets) that is never read at runtime in this mode.
3. It contradicts the architectural intent: in gateway mode, identity lives at the gateway, full stop.

The web container does keep Auth.js as a runtime dependency (it's used in `session` mode for local dev and any non-gateway deployment) — but it is not configured to function as an active session validator in gateway mode.

### Per-cloud mode selection via separate guard subclasses (rejected)

Make `AuthGuard` abstract and have `AlbOidcAuthGuard`, `GcpIapAuthGuard`, etc. extend it. **Rejected** as over-engineered for the dispatch this guard performs — a single guard with an `AUTH_MODE`-based switch and one parser per mode is clearer and short. The pattern can be revisited if a future mode needs significantly different request-handling logic, not just a different parser.

## Follow-ups

- **JWT signature verification per gateway mode** — [issue #115](https://github.com/exelab/agent-builder/issues/115). Applies to ALB OIDC and every future gateway. Status: open.
- **Revisit on second cloud template** — when GCP IAP, Cloudflare Access, or Azure Easy Auth lands, re-read this ADR. If the abstraction held up, no change. If it cracked under a new constraint, supersede with a follow-up ADR.
