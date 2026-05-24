# Agent Builder — AWS CDK Deployment

CDK template that deploys Agent Builder to AWS: VPC, Aurora Serverless v2, ECS Fargate (engine + web), an Application Load Balancer with HTTPS, and optional OIDC authentication enforced at the ALB layer.

This is a **starter template**. It assumes someone in your org already owns the identity provider — the CDK does not create one for you.

## Quick start

```bash
cp config.yaml.example config.yaml
# edit account, region, dns, auth as needed
npm install
npm run synth
npm run deploy
```

See `config.yaml.example` for the full set of knobs.

## Authentication model

The ALB does the OIDC dance via the `authenticate-oidc` listener action. ECS only accepts ingress from the ALB security group (`vpc-construct.ts`), so the engine trusts the `x-amzn-oidc-data` header without re-verifying the JWT signature — the network boundary is the trust boundary. See `packages/engine/src/auth/alb-oidc.service.ts` for the parser.

The `auth:` block in `config.yaml` is optional. Omit it and the app runs open (useful for early-stage testing). Fill it in and **every** route — web, API, and `/v1/*` — sits behind the IdP.

Any OIDC provider works: Cognito (with or without a federated upstream IdP), Okta, Auth0, Azure AD / Entra ID, Keycloak, etc.

### Enterprise pattern: Cognito as broker → corporate IdP

If your org runs AWS IAM Identity Center, Okta, or Entra ID, the recommended shape is:

1. Create a Cognito User Pool + App Client (one-time, manual — outside this CDK).
2. On the User Pool, add the corporate IdP as a SAML or OIDC identity provider.
3. On the App Client, **disable Cognito-local sign-in** and enable only the federated IdP.
4. Paste the resulting Cognito Hosted UI endpoints (issuer, authorize, token, userInfo) into `config.yaml`.

This keeps user lifecycle (provisioning, MFA, offboarding) inside your existing IdP and uses Cognito purely as the OIDC broker that ALB knows how to talk to.

## Operator notes (read before deploying with auth on)

These are the four things that bite every operator the first time they put an ALB-OIDC app in front of users. None are bugs in this template — they're properties of ALB's `authenticate-oidc` action that are worth knowing about.

### 1. There is no logout endpoint

ALB sets an `AWSELBAuthSessionCookie-*` cookie when a user authenticates. ALB itself exposes no logout endpoint — the cookie lives for the configured `sessionTimeout` (8h by default in `compute-construct.ts`) regardless of what the upstream IdP does.

If you need a working "Sign out" button, add a `/logout` route in the web app that:

- Clears the `AWSELBAuthSessionCookie-*` cookies (set them to an expired date on the app's domain), and
- 302-redirects to the IdP's `end_session_endpoint` (Cognito: `https://<domain>.auth.<region>.amazoncognito.com/logout?client_id=...&logout_uri=...`).

Without both halves, "logout" only clears the IdP session — the user is silently re-authenticated by the ALB cookie on the next request.

### 2. Skip the Cognito chooser screen with `identity_provider=...`

When Cognito has both local users and a federated IdP enabled, its Hosted UI shows a chooser. If you want users to go straight to Google / Okta / Entra without seeing the Cognito screen, append `?identity_provider=<ProviderName>` to `authorizationEndpoint` in `config.yaml`:

```yaml
auth:
  authorizationEndpoint: "https://my-pool.auth.eu-south-1.amazoncognito.com/oauth2/authorize?identity_provider=Google"
```

ALB appends its own params with `&`, so a pre-set query string is preserved. `<ProviderName>` is the name you gave the IdP on the User Pool (e.g. `Google`, `EntraID`, or the name of your SAML provider).

The cleaner alternative is to disable local sign-in on the App Client entirely (see the enterprise pattern above) — then there's no chooser to skip in the first place.

### 3. Group claim name is hardcoded to `cognito:groups`

`packages/engine/src/auth/alb-oidc.service.ts` reads the user's groups from the `cognito:groups` claim. Cognito emits this name natively; other IdPs don't.

- **Okta**: configure the OIDC app to emit a `groups` claim, then map it through Cognito as `cognito:groups`, **or** patch the parser to read `groups` directly.
- **Entra ID / Azure AD**: emits `groups` as an array of GUIDs. Same options as Okta.
- **Keycloak**: emits `groups` by default. Same options.

If you bypass Cognito and point ALB directly at a non-Cognito OIDC provider, you almost certainly need to either teach `alb-oidc.service.ts` about a different claim name or remap the claim at the IdP.

### 4. `scope` is hardcoded to `openid email profile`

Defined in `compute-construct.ts` on the `authenticateOidc` call. Some IdPs need additional scopes to actually emit certain claims:

- Groups often require an explicit `groups` scope (Okta, Auth0).
- Refresh tokens require `offline_access` on most providers.
- Custom claims may require provider-specific scopes.

If you need a different scope set, edit the `scope:` value in `compute-construct.ts`. It's not yet exposed in `config.yaml` — promote it to config when you need per-stage variation.

## Stack layout

| Construct | Resource |
|-----------|----------|
| `VpcConstruct` | VPC + public/private subnets + security groups (`albSg`, `ecsSg`, `dbSg`) |
| `DatabaseConstruct` | Aurora Serverless v2 cluster + `dbSecret` + `appSecret` (Secrets Manager) |
| `ComputeConstruct` | ECS Fargate service (engine + web sidecars) + ALB + listener rules + optional OIDC |
| `DnsConstruct` | (Optional) Route 53 alias to ALB |

See `lib/stacks/main-stack.ts` for the wiring.
