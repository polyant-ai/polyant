# AWS CDK Deployment — Design Spec

## Overview

Full-spec AWS CDK deployment of the Agent Builder monorepo (engine + web) to test3-prod account (`870676149456`). Single Fargate task, Aurora Serverless v2, public-subnet VPC.

> **Status update (2026-04-27):** this spec was written for the initial HTTP-only scope. The deployment now ships with **HTTPS + ALB OIDC (Cognito)** at `https://ab-test3.apps.exelab.net`. The original HTTP-only path is still supported as a config option (omit the `dns` and `auth` blocks in `config.yaml`).
>
> **Auth & TLS — what shipped:**
> - HTTPS on AWS ALB requires a domain + ACM cert. AWS provides no default TLS cert on the raw ALB DNS, so the `dns` block is required whenever `auth` is set; `infra/bin/app.ts` enforces this at synth time.
> - The engine runs in **gateway-authenticated mode** when `auth` is configured (`AUTH_MODE=alb-oidc`). It trusts the `x-amzn-oidc-data` header from the ALB without verifying the JWT signature, relying on the ECS security group for network isolation. See [ADR-0001](../../adr/0001-gateway-authenticated-mode.md) for the trust model and the deferred follow-up to add signature verification.
> - The web container in this mode does NOT receive `AUTH_SECRET`, `POSTGRES_*`, or `GOOGLE_*` secrets — they are unused because Auth.js Edge middleware sees no cookie to decrypt. See `infra/config.yaml.example` for the current required/optional structure.

**Target cost at idle:** ~$50-80/month (Aurora Serverless 0.5 ACU + 1 Fargate task)

**Test account:** `870676149456` (test3-prod), profile `test3-prod`, region `eu-south-1`

## Architecture

```
                     ALB (HTTP:80)
                     agent-builder-alb-dev
                     ┌──────┬───────────────┐
                     │      │               │
                /api/* /v1/*          /* (default)
                /memories/*
                     │               │
       ┌─────────────┴───────────────┴─────────────┐
       │  Fargate Task: agent-builder-task-dev       │
       │  ┌──────────────────┐ ┌─────────────────┐  │
       │  │  engine (NestJS)  │ │  web (Next.js)  │  │
       │  │  port 4000        │ │  port 3000      │  │
       │  │  CPU: 768         │ │  CPU: 256       │  │
       │  │  Mem: 1536 MB     │ │  Mem: 512 MB    │  │
       │  └──────────────────┘ └─────────────────┘  │
       └─────────────┬──────────────────────────────┘
                     │
       ┌─────────────┴─────────────────┐
       │  Aurora Serverless v2          │
       │  agent-builder-db-dev          │
       │  PostgreSQL 16 + pgvector      │
       │  0.5 - 4 ACU                  │
       └────────────────────────────────┘

  ┌──────────────────────────────────────────────────┐
  │  VPC: agent-builder-vpc-dev                       │
  │  CIDR: 10.0.0.0/16                               │
  │  Public subnets only (2 AZs) — No NAT            │
  │  Internet Gateway for outbound                    │
  └──────────────────────────────────────────────────┘
```

## Section 1: Network & Security

### VPC

- **Name:** `agent-builder-vpc-dev`
- **CIDR:** `10.0.0.0/16`
- **Subnets:** 2 public subnets across 2 AZs
  - `10.0.1.0/24` (AZ-a)
  - `10.0.2.0/24` (AZ-b)
- **Internet Gateway:** yes
- **NAT Gateway:** none
- **VPC Endpoints:** none (ECS has public IPs for outbound)

### Security Groups

**ALB SG** (`agent-builder-alb-sg-dev`):
- Inbound: TCP 80 from `0.0.0.0/0`
- Outbound: all

**ECS SG** (`agent-builder-ecs-sg-dev`):
- Inbound: TCP 3000, 4000 from ALB SG only
- Outbound: all (Bedrock, Telegram, Slack, OpenAI, Tavily, LangSmith)

**DB SG** (`agent-builder-db-sg-dev`):
- Inbound: TCP 5432 from ECS SG only
- Outbound: none needed

## Section 2: Compute (ECS Fargate)

### Cluster & Service

- **Cluster:** `agent-builder-cluster-dev`
- **Service:** `agent-builder-service-dev`
- **Desired count:** 1
- **Platform version:** LATEST
- **Assign public IP:** true (required for outbound without NAT)

### Task Definition

- **Family:** `agent-builder-task-dev`
- **Total CPU:** 1024 (1 vCPU)
- **Total Memory:** 2048 MB

**Engine container (essential):**
- Image: CDK asset build from `Dockerfile.engine` (repo root context)
- Port mapping: 4000
- CPU: 768 / Memory: 1536 MB
- Health check: HTTP GET `/health` → 200
- Stop timeout: 120 seconds (streaming LLM responses)
- Environment variables:
  - `API_PORT=4000`
  - `POSTGRES_SSL=true`
  - `DEFAULT_INSTANCE_ID=default`
  - `DATETIME_TIMEZONE=Europe/Rome`
  - `DATETIME_LOCALE=it-IT`
- Secrets (from Secrets Manager):
  - `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (from DB secret)
  - `ENCRYPTION_KEY` (from app secret)
- Logging: CloudWatch `/ecs/agent-builder-engine-dev` (retention: 30 days)

**Web container (essential):**
- Image: CDK asset build from `Dockerfile.web` (repo root context)
- Port mapping: 3000
- CPU: 256 / Memory: 512 MB
- Health check: HTTP GET `/` → 200
- Environment variables:
  - `INTERNAL_API_URL=http://localhost:4000` (server-side Next.js → engine)
- Logging: CloudWatch `/ecs/agent-builder-web-dev` (retention: 30 days)

### ALB

- **Name:** `agent-builder-alb-dev`
- **Scheme:** internet-facing
- **Subnets:** both public subnets
- **Security group:** ALB SG

**Listener:**
- HTTP:80 → routing rules

**Target Groups:**
- `agent-builder-engine-tg-dev`: paths `/api/*`, `/v1/*`, `/memories/*` → port 4000
- `agent-builder-web-tg-dev`: default action `/*` → port 3000

**Health checks:**
- Engine TG: `/health`, interval 30s, healthy threshold 2
- Web TG: `/`, interval 30s, healthy threshold 2

### IAM Roles

**Task Role** (`agent-builder-task-role-dev`):
- `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` on `arn:aws:bedrock:*::foundation-model/*`
- `secretsmanager:GetSecretValue` on app secrets ARN
- `logs:CreateLogGroup`, `logs:PutLogEvents`

**Execution Role** (`agent-builder-exec-role-dev`):
- `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`
- `secretsmanager:GetSecretValue` (for injecting secrets as env vars)
- `logs:CreateLogGroup`, `logs:PutLogEvents`

## Section 3: Database (Aurora Serverless v2)

### Cluster

- **Identifier:** `agent-builder-db-dev`
- **Engine:** `aurora-postgresql` (PostgreSQL 16-compatible)
- **Serverless v2 scaling:** 0.5 min ACU / 4 max ACU
- **Instance count:** 1 writer (no reader)
- **Publicly accessible:** true (DNS resolution in public-subnet VPC; security via SG)
- **Subnet group:** both public subnets
- **Security group:** DB SG
- **Storage encryption:** AWS-managed KMS key
- **Backup retention:** 7 days
- **Deletion protection:** false (test environment)
- **Removal policy:** DESTROY (test environment)
- **SSL enforced:** `rds.force_ssl=1`

### Database & Secrets

- **Database name:** `agent_crm`
- **App user:** auto-generated by CDK, credentials in Secrets Manager

**DB Secret** (`agent-builder-db-secrets-dev`):
- Auto-generated by CDK (Aurora default secret)
- Contains: host, port, dbname, username, password
- Injected into ECS task as `POSTGRES_*` env vars

**App Secret** (`agent-builder-secrets-dev`):
- Created by CDK with placeholder value
- Populated manually after first deploy
- Contains: `encryption_key` (64 hex chars for AES-256-GCM)

### Post-deploy SQL (one-time)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## Section 4: Application Code Changes

Six changes to existing code:

| # | File | Change | Reason |
|---|------|--------|--------|
| 1 | `packages/web/next.config.ts` | Add `output: 'standalone'` | Required for Docker multi-stage build |
| 2 | `packages/engine/src/database/client.ts` | Read `POSTGRES_SSL` env var, pass `ssl: { rejectUnauthorized: true }` when set | Aurora enforces SSL; local Docker PostgreSQL does not |
| 3 | `packages/engine/drizzle.config.ts` | Same SSL support via env var | Drizzle migrations must also connect via SSL |
| 4 | `packages/web/src/lib/api.ts` | Change default `API_BASE` to `""` (empty string = relative paths). Keep `NEXT_PUBLIC_API_URL` override for local dev | `localhost:4000` unreachable from browsers in production; relative paths route through ALB |
| 5 | `packages/engine/src/ai-gateway/providers/bedrock.ts` | Change default region from `"us-east-1"` to `process.env.AWS_REGION ?? "us-east-1"` | ECS sets `AWS_REGION` automatically; aligns Bedrock calls with deployment region |
| 6 | `packages/engine/src/config.ts` | Add `POSTGRES_SSL` as optional boolean env var | Zod validation for the new SSL config |

**Already exists:** Health endpoint at `/health` returning `{ status: "ok", timestamp, service }`.

## Section 5: CDK Project Structure

Standalone TypeScript CDK app at `infra/` (not an npm workspace):

```
infra/
├── bin/
│   └── app.ts                    # CDK entrypoint, loads config.yaml
├── lib/
│   ├── stacks/
│   │   └── main-stack.ts         # Single stack composing all constructs
│   └── constructs/
│       ├── vpc-construct.ts      # VPC, public subnets, IGW, SGs
│       ├── database-construct.ts # Aurora Serverless v2, secrets
│       └── compute-construct.ts  # ECS cluster, task def, service, ALB
├── config.yaml                   # Environment configuration
├── cdk.json
├── package.json                  # CDK + constructs deps
└── tsconfig.json
```

### Dockerfiles (repo root)

**`Dockerfile.engine`** — multi-stage build:
1. `base`: Node.js 22 alpine, install npm workspaces
2. `build`: `npm run build:engine`
3. `runtime`: copy dist + node_modules, expose 4000, entrypoint runs migrations then `node dist/index.js`

**`Dockerfile.web`** — multi-stage build:
1. `base`: Node.js 22 alpine, install npm workspaces
2. `build`: `npm run build:web` (Next.js standalone output)
3. `runtime`: copy `.next/standalone` + `.next/static` + `public`, expose 3000, `node server.js`

### config.yaml (pre-filled for test3-prod)

```yaml
dev:
  account: "870676149456"
  region: "eu-south-1"
  vpc:
    cidr: "10.0.0.0/16"
  database:
    minAcu: 0.5
    maxAcu: 4
    deletionProtection: false
  ecs:
    cpu: 1024
    memory: 2048
    desiredCount: 1
    stopTimeout: 120
    engine:
      cpu: 768
      memory: 1536
    web:
      cpu: 256
      memory: 512
  logging:
    retentionDays: 30
  app:
    defaultInstanceId: "default"
    timezone: "Europe/Rome"
    locale: "it-IT"
  tags:
    Project: "agent-builder"
    Environment: "dev"
```

## Section 6: Deployment Runbook

### First-time deployment

```bash
# 1. Deploy infrastructure
source awsume test3-prod
cd infra && npm install && npx cdk deploy

# 2. Initialize database (one-time)
./scripts/db-init.sh

# 3. Populate app secret
aws secretsmanager put-secret-value \
  --secret-id agent-builder-secrets-dev \
  --secret-string '{"encryption_key":"<64-hex-chars>"}'

# 4. Verify
curl http://<alb-dns>/health
curl http://<alb-dns>/api/instances
```

### Subsequent deploys

```bash
source awsume test3-prod
cd infra && npx cdk deploy
# CDK rebuilds Docker images and deploys new task revision
```

## Out of Scope

- DNS / TLS (raw ALB URL for testing, add later)
- CI/CD pipelines
- IAM developer DB access (use Secrets Manager creds directly)
- Multi-AZ Aurora reader
- WAF
- ECS auto-scaling
- WAHA/WhatsApp server deployment
- Monitoring/alerting dashboards
