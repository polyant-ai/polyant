# AWS CDK Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Polyant (engine + web) to AWS account `<account-id>` (test3-prod) with a single `cdk deploy` command.

**Architecture:** CDK standalone app in `infra/` creates VPC, Aurora Serverless v2, ECS Fargate (2 containers in 1 task), and ALB. Dockerfiles at repo root build engine and web images. Six application code changes enable SSL, relative API paths, and Bedrock region.

**Tech Stack:** AWS CDK v2 (TypeScript), Docker multi-stage builds, Aurora PostgreSQL 16 + pgvector, ECS Fargate, ALB

**Worktree:** `/Users/fabrizio/Work/polyant/.worktrees/feat/issue-90-aws-cdk-deployment`

**Spec:** `docs/superpowers/specs/2026-04-16-aws-cdk-deployment-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `infra/bin/app.ts` | CDK entrypoint — loads config.yaml, instantiates stack |
| `infra/lib/stacks/main-stack.ts` | Single stack composing VPC, DB, Compute constructs |
| `infra/lib/constructs/vpc-construct.ts` | VPC, 2 public subnets, IGW, 3 security groups |
| `infra/lib/constructs/database-construct.ts` | Aurora Serverless v2, DB secret, app secret |
| `infra/lib/constructs/compute-construct.ts` | ECS cluster, task def (2 containers), service, ALB |
| `infra/config.yaml` | Environment config (account, region, sizing) |
| `infra/cdk.json` | CDK app config |
| `infra/package.json` | CDK dependencies |
| `infra/tsconfig.json` | TypeScript config for CDK |
| `Dockerfile.engine` | Multi-stage build for engine container |
| `Dockerfile.web` | Multi-stage build for web container |
| `docker-entrypoint.sh` | Engine entrypoint — runs migrations then starts |
| `.dockerignore` | Exclude node_modules, .git, etc. from Docker context |
| `scripts/db-init.sh` | Post-deploy: creates pgvector extension |

### Modified Files

| File | Change |
|------|--------|
| `packages/engine/src/config.ts` | Add `POSTGRES_SSL` optional boolean |
| `packages/engine/src/database/client.ts` | Pass `ssl` option when `POSTGRES_SSL=true` |
| `packages/engine/src/database/migrate.ts` | Pass `ssl` option when `POSTGRES_SSL=true` |
| `packages/engine/drizzle.config.ts` | Read `POSTGRES_SSL` env var for SSL config |
| `packages/web/next.config.ts` | Add `output: 'standalone'` |
| `packages/web/src/lib/api.ts` | Change default API_BASE to `""` |
| `packages/engine/src/ai-gateway/providers/bedrock.ts` | Default region from `AWS_REGION` env var |
| `.gitignore` | Add `infra/cdk.out/`, `infra/node_modules/` |

---

## Task 1: Application Code Changes — SSL & Config

**Files:**
- Modify: `packages/engine/src/config.ts:22-55`
- Modify: `packages/engine/src/database/client.ts`
- Modify: `packages/engine/src/database/migrate.ts`
- Modify: `packages/engine/drizzle.config.ts:43-50`

- [ ] **Step 1: Add POSTGRES_SSL to Zod config schema**

In `packages/engine/src/config.ts`, add `ssl` field to the `postgres` object in `configSchema`:

```typescript
postgres: z.object({
  host: z.string().default("localhost"),
  port: z.coerce.number().default(5432),
  database: z.string().default("polyant"),
  user: z.string().default("crm"),
  password: z.string(),
  ssl: z.coerce.boolean().default(false),
}),
```

And in `loadConfig()`, add the env var mapping:

```typescript
postgres: {
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl: process.env.POSTGRES_SSL,
},
```

- [ ] **Step 2: Use SSL in database client**

Replace `packages/engine/src/database/client.ts` with:

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";

const queryClient = postgres({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
  connection: { TimeZone: "UTC" },
  ssl: config.postgres.ssl ? { rejectUnauthorized: true } : false,
});

export const db = drizzle(queryClient);

export { queryClient };
```

- [ ] **Step 3: Use SSL in migrate.ts**

In `packages/engine/src/database/migrate.ts`, change the postgres connection (line 24-25) to read `POSTGRES_SSL`:

```typescript
const sslEnabled = process.env.POSTGRES_SSL === "true";
const connectionString = `postgresql://${user}:${password}@${host}:${port}/${database}`;
const sql = postgres(connectionString, {
  max: 1,
  ssl: sslEnabled ? { rejectUnauthorized: true } : false,
});
```

- [ ] **Step 4: Use SSL in drizzle.config.ts**

In `packages/engine/drizzle.config.ts`, change line 49 from `ssl: false` to:

```typescript
ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : false,
```

- [ ] **Step 5: Verify local dev still works**

Run from worktree root:
```bash
npm run typecheck -w @polyant/engine
```
Expected: passes (POSTGRES_SSL defaults to false, no behavior change locally)

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/config.ts packages/engine/src/database/client.ts packages/engine/src/database/migrate.ts packages/engine/drizzle.config.ts
git commit -m "feat(engine): add POSTGRES_SSL support for Aurora connections"
```

---

## Task 2: Application Code Changes — API Base, Bedrock Region, Standalone Output

**Files:**
- Modify: `packages/web/src/lib/api.ts:101`
- Modify: `packages/web/next.config.ts`
- Modify: `packages/engine/src/ai-gateway/providers/bedrock.ts:7`

- [ ] **Step 1: Change API_BASE default to empty string**

In `packages/web/src/lib/api.ts`, change line 101 from:

```typescript
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
```

to:

```typescript
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
```

**Note:** Local dev must set `NEXT_PUBLIC_API_URL=http://localhost:4000` in `.env` or `.env.local`. Verify `.env` already has this — it does (via the `NEXT_PUBLIC_API_URL` or engine running on 4000).

- [ ] **Step 2: Add standalone output to next.config.ts**

In `packages/web/next.config.ts`, add `output: "standalone"`:

```typescript
const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};
```

- [ ] **Step 3: Change Bedrock default region**

In `packages/engine/src/ai-gateway/providers/bedrock.ts`, change line 7 from:

```typescript
const region = apiKeys?.bedrock_region ?? "us-east-1";
```

to:

```typescript
const region = apiKeys?.bedrock_region ?? process.env.AWS_REGION ?? "us-east-1";
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck -w @polyant/engine
npm run typecheck -w @polyant/web
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/next.config.ts packages/engine/src/ai-gateway/providers/bedrock.ts
git commit -m "feat: standalone Next.js output, relative API paths, Bedrock region from env"
```

---

## Task 3: Dockerfiles & Entrypoint

**Files:**
- Create: `Dockerfile.engine`
- Create: `Dockerfile.web`
- Create: `docker-entrypoint.sh`
- Create: `.dockerignore`

- [ ] **Step 1: Create .dockerignore**

Create `.dockerignore` at repo root:

```dockerignore
node_modules
.git
.gitignore
.env
.env.local
*.log
.DS_Store
.next
dist
coverage
.worktrees
.claude
docs
infra/cdk.out
infra/node_modules
```

- [ ] **Step 2: Create docker-entrypoint.sh**

Create `docker-entrypoint.sh` at repo root:

```bash
#!/bin/sh
set -e

echo "Running database migrations..."
node --import tsx packages/engine/src/database/migrate.ts

echo "Starting engine..."
exec node packages/engine/dist/index.js
```

- [ ] **Step 3: Make entrypoint executable**

```bash
chmod +x docker-entrypoint.sh
```

- [ ] **Step 4: Create Dockerfile.engine**

Create `Dockerfile.engine` at repo root:

```dockerfile
# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
# Create a minimal package.json for web to satisfy workspace resolution
RUN mkdir -p packages/web && echo '{"name":"@polyant/web","version":"0.1.0","private":true}' > packages/web/package.json
RUN npm ci --workspace=@polyant/engine --include-workspace-root

# ── Stage 2: Build ─────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/engine/node_modules ./packages/engine/node_modules
COPY package.json package-lock.json ./
COPY packages/engine/ packages/engine/
RUN npm run build -w @polyant/engine

# ── Stage 3: Runtime ───────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy built output and dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/engine/node_modules ./packages/engine/node_modules
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY packages/engine/package.json packages/engine/
COPY package.json ./

# Copy migration files (needed by entrypoint)
COPY packages/engine/src/database/migrations packages/engine/src/database/migrations
COPY packages/engine/src/database/migrate.ts packages/engine/src/database/

# tsx is needed for running migrate.ts at startup
RUN npm install -g tsx

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4000

ENTRYPOINT ["docker-entrypoint.sh"]
```

- [ ] **Step 5: Create Dockerfile.web**

Create `Dockerfile.web` at repo root:

```dockerfile
# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/web/package.json packages/web/
# Create minimal engine package.json for workspace resolution
RUN mkdir -p packages/engine && echo '{"name":"@polyant/engine","version":"0.1.0","private":true}' > packages/engine/package.json
RUN npm ci --workspace=@polyant/web --include-workspace-root

# ── Stage 2: Build ─────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY package.json package-lock.json ./
COPY packages/web/ packages/web/

# NEXT_PUBLIC_API_URL must be empty at build time for relative paths
ENV NEXT_PUBLIC_API_URL=""
RUN npm run build -w @polyant/web

# ── Stage 3: Runtime ───────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy Next.js standalone output
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=build /app/packages/web/public ./packages/web/public

EXPOSE 3000

CMD ["node", "packages/web/server.js"]
```

- [ ] **Step 6: Verify Docker builds locally**

```bash
docker build -f Dockerfile.engine -t polyant-engine:test .
docker build -f Dockerfile.web -t polyant-web:test .
```

Expected: both build successfully. Don't need to run them — CDK will build and push.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile.engine Dockerfile.web docker-entrypoint.sh .dockerignore
git commit -m "feat: add Dockerfiles for engine and web containers"
```

---

## Task 4: CDK Project Scaffold

**Files:**
- Create: `infra/package.json`
- Create: `infra/tsconfig.json`
- Create: `infra/cdk.json`
- Create: `infra/config.yaml`
- Create: `infra/bin/app.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Create infra/package.json**

```json
{
  "name": "polyant-infra",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "synth": "cdk synth",
    "deploy": "cdk deploy",
    "destroy": "cdk destroy"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.190.0",
    "constructs": "^10.4.0",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "aws-cdk": "^2.190.0"
  }
}
```

- [ ] **Step 2: Create infra/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["bin/**/*", "lib/**/*"],
  "exclude": ["node_modules", "dist", "cdk.out"]
}
```

- [ ] **Step 3: Create infra/cdk.json**

```json
{
  "app": "npx tsx bin/app.ts",
  "requireApproval": "broadening",
  "context": {
    "@aws-cdk/aws-ecs:disableExplicitDeploymentControllerForCircuitBreaker": true
  }
}
```

- [ ] **Step 4: Create infra/config.yaml**

```yaml
dev:
  account: "<account-id>"
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
    Project: "polyant"
    Environment: "dev"
```

- [ ] **Step 5: Create infra/bin/app.ts**

```typescript
#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { MainStack } from "../lib/stacks/main-stack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
const configPath = resolve(__dirname, "../config.yaml");
const configFile = yaml.load(readFileSync(configPath, "utf8")) as Record<string, unknown>;

const stage = process.env.CDK_STAGE ?? "dev";
const stageConfig = configFile[stage] as {
  account: string;
  region: string;
  vpc: { cidr: string };
  database: { minAcu: number; maxAcu: number; deletionProtection: boolean };
  ecs: {
    cpu: number;
    memory: number;
    desiredCount: number;
    stopTimeout: number;
    engine: { cpu: number; memory: number };
    web: { cpu: number; memory: number };
  };
  logging: { retentionDays: number };
  app: { defaultInstanceId: string; timezone: string; locale: string };
  tags: Record<string, string>;
};

if (!stageConfig) {
  throw new Error(`No config found for stage "${stage}" in config.yaml`);
}
if (!stageConfig.account) {
  throw new Error(`"account" is required in config.yaml for stage "${stage}"`);
}

const app = new App();

new MainStack(app, `polyant-${stage}`, {
  env: { account: stageConfig.account, region: stageConfig.region },
  stage,
  config: stageConfig,
});

app.synth();
```

- [ ] **Step 6: Add infra ignores to .gitignore**

Append to `.gitignore`:

```
# CDK
infra/cdk.out/
infra/node_modules/
infra/dist/
```

- [ ] **Step 7: Install CDK dependencies**

```bash
cd infra && npm install
```

- [ ] **Step 8: Commit**

```bash
git add infra/package.json infra/package-lock.json infra/tsconfig.json infra/cdk.json infra/config.yaml infra/bin/app.ts .gitignore
git commit -m "feat(infra): scaffold CDK project with config"
```

---

## Task 5: VPC Construct

**Files:**
- Create: `infra/lib/constructs/vpc-construct.ts`

- [ ] **Step 1: Create VPC construct**

Create `infra/lib/constructs/vpc-construct.ts`:

```typescript
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface VpcConstructProps {
  stage: string;
  cidr: string;
}

export class VpcConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `polyant-vpc-${props.stage}`,
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ALB Security Group
    this.albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc: this.vpc,
      securityGroupName: `polyant-alb-sg-${props.stage}`,
      description: "ALB security group",
      allowAllOutbound: true,
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");

    // ECS Security Group
    this.ecsSg = new ec2.SecurityGroup(this, "EcsSg", {
      vpc: this.vpc,
      securityGroupName: `polyant-ecs-sg-${props.stage}`,
      description: "ECS tasks security group",
      allowAllOutbound: true,
    });
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(3000), "ALB to web");
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(4000), "ALB to engine");

    // DB Security Group
    this.dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc: this.vpc,
      securityGroupName: `polyant-db-sg-${props.stage}`,
      description: "Aurora security group",
      allowAllOutbound: false,
    });
    this.dbSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5432), "ECS to Aurora");
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/lib/constructs/vpc-construct.ts
git commit -m "feat(infra): add VPC construct with security groups"
```

---

## Task 6: Database Construct

**Files:**
- Create: `infra/lib/constructs/database-construct.ts`

- [ ] **Step 1: Create database construct**

Create `infra/lib/constructs/database-construct.ts`:

```typescript
import { Construct } from "constructs";
import { RemovalPolicy, Duration } from "aws-cdk-lib";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

export interface DatabaseConstructProps {
  stage: string;
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  minAcu: number;
  maxAcu: number;
  deletionProtection: boolean;
}

export class DatabaseConstruct extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly dbSecret: rds.DatabaseSecret;
  public readonly appSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    // DB credentials secret
    this.dbSecret = new rds.DatabaseSecret(this, "DbSecret", {
      secretName: `polyant-db-secrets-${props.stage}`,
      username: "polyant",
    });

    // Aurora Serverless v2 cluster
    this.cluster = new rds.DatabaseCluster(this, "Cluster", {
      clusterIdentifier: `polyant-db-${props.stage}`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      defaultDatabaseName: "polyant",
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [props.securityGroup],
      serverlessV2MinCapacity: props.minAcu,
      serverlessV2MaxCapacity: props.maxAcu,
      writer: rds.ClusterInstance.serverlessV2("writer", {
        publiclyAccessible: true,
      }),
      storageEncrypted: true,
      backup: { retention: Duration.days(7) },
      deletionProtection: props.deletionProtection,
      removalPolicy: props.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      parameterGroup: new rds.ParameterGroup(this, "Params", {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_16_4,
        }),
        parameters: {
          "rds.force_ssl": "1",
        },
      }),
    });

    // App secret (encryption key — placeholder, populated manually after deploy)
    this.appSecret = new secretsmanager.Secret(this, "AppSecret", {
      secretName: `polyant-secrets-${props.stage}`,
      description: "Polyant application secrets (encryption_key)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ encryption_key: "REPLACE_ME_WITH_64_HEX_CHARS" }),
        generateStringKey: "_placeholder",
      },
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/lib/constructs/database-construct.ts
git commit -m "feat(infra): add Aurora Serverless v2 database construct"
```

---

## Task 7: Compute Construct

**Files:**
- Create: `infra/lib/constructs/compute-construct.ts`

- [ ] **Step 1: Create compute construct**

Create `infra/lib/constructs/compute-construct.ts`:

```typescript
import { Construct } from "constructs";
import { Duration, CfnOutput } from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as rds from "aws-cdk-lib/aws-rds";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

export interface ComputeConstructProps {
  stage: string;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  ecsSg: ec2.ISecurityGroup;
  dbCluster: rds.DatabaseCluster;
  dbSecret: rds.DatabaseSecret;
  appSecret: secretsmanager.ISecret;
  ecsConfig: {
    cpu: number;
    memory: number;
    desiredCount: number;
    stopTimeout: number;
    engine: { cpu: number; memory: number };
    web: { cpu: number; memory: number };
  };
  appConfig: {
    defaultInstanceId: string;
    timezone: string;
    locale: string;
  };
  loggingRetentionDays: number;
}

export class ComputeConstruct extends Construct {
  public readonly albDnsName: string;

  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    // ── ECS Cluster ───────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: `polyant-cluster-${props.stage}`,
      vpc: props.vpc,
    });

    // ── IAM Task Role ─────────────────────────────────────────
    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: `polyant-task-role-${props.stage}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Bedrock access (all regions — model availability varies)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["arn:aws:bedrock:*::foundation-model/*"],
      }),
    );

    // Secrets Manager read for app secret
    props.appSecret.grantRead(taskRole);

    // CloudWatch Logs
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"],
      }),
    );

    // ── Task Definition ───────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      family: `polyant-task-${props.stage}`,
      cpu: props.ecsConfig.cpu,
      memoryLimitMiB: props.ecsConfig.memory,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // ── Engine Container ──────────────────────────────────────
    const engineLogGroup = new logs.LogGroup(this, "EngineLogGroup", {
      logGroupName: `/ecs/polyant-engine-${props.stage}`,
      retention: props.loggingRetentionDays,
    });

    const engineContainer = taskDef.addContainer("engine", {
      containerName: "engine",
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: "Dockerfile.engine",
      }),
      cpu: props.ecsConfig.engine.cpu,
      memoryLimitMiB: props.ecsConfig.engine.memory,
      essential: true,
      stopTimeout: Duration.seconds(props.ecsConfig.stopTimeout),
      environment: {
        API_PORT: "4000",
        POSTGRES_SSL: "true",
        DEFAULT_INSTANCE_ID: props.appConfig.defaultInstanceId,
        DATETIME_TIMEZONE: props.appConfig.timezone,
        DATETIME_LOCALE: props.appConfig.locale,
      },
      secrets: {
        POSTGRES_HOST: ecs.Secret.fromSecretsManager(props.dbSecret, "host"),
        POSTGRES_PORT: ecs.Secret.fromSecretsManager(props.dbSecret, "port"),
        POSTGRES_DB: ecs.Secret.fromSecretsManager(props.dbSecret, "dbname"),
        POSTGRES_USER: ecs.Secret.fromSecretsManager(props.dbSecret, "username"),
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, "password"),
        ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(props.appSecret, "encryption_key"),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: engineLogGroup,
        streamPrefix: "engine",
      }),
      healthCheck: {
        command: ["CMD-SHELL", "wget -q --spider http://localhost:4000/health || exit 1"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
      portMappings: [{ containerPort: 4000 }],
    });

    // ── Web Container ─────────────────────────────────────────
    const webLogGroup = new logs.LogGroup(this, "WebLogGroup", {
      logGroupName: `/ecs/polyant-web-${props.stage}`,
      retention: props.loggingRetentionDays,
    });

    taskDef.addContainer("web", {
      containerName: "web",
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: "Dockerfile.web",
      }),
      cpu: props.ecsConfig.web.cpu,
      memoryLimitMiB: props.ecsConfig.web.memory,
      essential: true,
      environment: {
        INTERNAL_API_URL: "http://localhost:4000",
        HOSTNAME: "0.0.0.0",
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: webLogGroup,
        streamPrefix: "web",
      }),
      healthCheck: {
        command: ["CMD-SHELL", "wget -q --spider http://localhost:3000/ || exit 1"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
      portMappings: [{ containerPort: 3000 }],
    });

    // ── ALB ───────────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      loadBalancerName: `polyant-alb-${props.stage}`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // ── ECS Service ───────────────────────────────────────────
    const service = new ecs.FargateService(this, "Service", {
      serviceName: `polyant-service-${props.stage}`,
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.ecsConfig.desiredCount,
      assignPublicIp: true,
      securityGroups: [props.ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Engine target group (API routes)
    const engineTg = new elbv2.ApplicationTargetGroup(this, "EngineTg", {
      targetGroupName: `ab-engine-tg-${props.stage}`,
      vpc: props.vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: "engine",
          containerPort: 4000,
        }),
      ],
      healthCheck: {
        path: "/health",
        interval: Duration.seconds(30),
        healthyThresholdCount: 2,
      },
    });

    // Web target group (default)
    const webTg = new elbv2.ApplicationTargetGroup(this, "WebTg", {
      targetGroupName: `ab-web-tg-${props.stage}`,
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: "web",
          containerPort: 3000,
        }),
      ],
      healthCheck: {
        path: "/",
        interval: Duration.seconds(30),
        healthyThresholdCount: 2,
      },
    });

    // Route API paths to engine, everything else to web
    listener.addTargetGroups("EngineRouting", {
      targetGroups: [engineTg],
      conditions: [
        elbv2.ListenerCondition.pathPatterns(["/api/*", "/v1/*", "/memories/*", "/health"]),
      ],
      priority: 10,
    });

    listener.addTargetGroups("WebDefault", {
      targetGroups: [webTg],
    });

    this.albDnsName = alb.loadBalancerDnsName;

    new CfnOutput(this, "AlbUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "ALB URL",
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/lib/constructs/compute-construct.ts
git commit -m "feat(infra): add ECS Fargate compute construct with ALB"
```

---

## Task 8: Main Stack — Wire Everything Together

**Files:**
- Create: `infra/lib/stacks/main-stack.ts`

- [ ] **Step 1: Create main stack**

Create `infra/lib/stacks/main-stack.ts`:

```typescript
import { Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import { VpcConstruct } from "../constructs/vpc-construct.js";
import { DatabaseConstruct } from "../constructs/database-construct.js";
import { ComputeConstruct } from "../constructs/compute-construct.js";

export interface MainStackProps extends StackProps {
  stage: string;
  config: {
    vpc: { cidr: string };
    database: { minAcu: number; maxAcu: number; deletionProtection: boolean };
    ecs: {
      cpu: number;
      memory: number;
      desiredCount: number;
      stopTimeout: number;
      engine: { cpu: number; memory: number };
      web: { cpu: number; memory: number };
    };
    logging: { retentionDays: number };
    app: { defaultInstanceId: string; timezone: string; locale: string };
    tags: Record<string, string>;
  };
}

export class MainStack extends Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    // Apply tags
    for (const [key, value] of Object.entries(props.config.tags)) {
      Tags.of(this).add(key, value);
    }

    // VPC + Security Groups
    const network = new VpcConstruct(this, "Network", {
      stage: props.stage,
      cidr: props.config.vpc.cidr,
    });

    // Aurora Serverless v2
    const database = new DatabaseConstruct(this, "Database", {
      stage: props.stage,
      vpc: network.vpc,
      securityGroup: network.dbSg,
      minAcu: props.config.database.minAcu,
      maxAcu: props.config.database.maxAcu,
      deletionProtection: props.config.database.deletionProtection,
    });

    // ECS Fargate + ALB
    new ComputeConstruct(this, "Compute", {
      stage: props.stage,
      vpc: network.vpc,
      albSg: network.albSg,
      ecsSg: network.ecsSg,
      dbCluster: database.cluster,
      dbSecret: database.dbSecret,
      appSecret: database.appSecret,
      ecsConfig: props.config.ecs,
      appConfig: props.config.app,
      loggingRetentionDays: props.config.logging.retentionDays,
    });
  }
}
```

- [ ] **Step 2: Verify CDK synth**

```bash
cd infra && npx cdk synth
```

Expected: CloudFormation template generated in `cdk.out/` without errors.

- [ ] **Step 3: Commit**

```bash
git add infra/lib/stacks/main-stack.ts
git commit -m "feat(infra): add main stack wiring VPC, database, and compute"
```

---

## Task 9: Scripts & Gitignore

**Files:**
- Create: `scripts/db-init.sh`

- [ ] **Step 1: Create db-init.sh**

Create `scripts/db-init.sh`:

```bash
#!/bin/bash
set -euo pipefail

# Reads Aurora endpoint from CloudFormation outputs and initializes pgvector extension.
# Usage: source awsume test3-prod && ./scripts/db-init.sh

STAGE="${CDK_STAGE:-dev}"
STACK_NAME="polyant-${STAGE}"
REGION="${AWS_REGION:-eu-south-1}"

echo "Reading DB credentials from Secrets Manager..."
SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?contains(OutputKey,`DbSecret`)].OutputValue' \
  --output text --region "$REGION" 2>/dev/null || true)

if [ -z "$SECRET_ARN" ]; then
  # Fallback: find secret by name
  SECRET_ARN=$(aws secretsmanager list-secrets \
    --filter Key="name",Values="polyant-db-secrets-${STAGE}" \
    --query 'SecretList[0].ARN' --output text --region "$REGION")
fi

SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" --region "$REGION" \
  --query 'SecretString' --output text)

DB_HOST=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['host'])")
DB_PORT=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")
DB_NAME=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('dbname','polyant'))")
DB_USER=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['username'])")
DB_PASS=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")

echo "Connecting to ${DB_HOST}:${DB_PORT}/${DB_NAME} as ${DB_USER}..."
echo "Creating pgvector extension..."

PGPASSWORD="$DB_PASS" psql \
  "host=${DB_HOST} port=${DB_PORT} dbname=${DB_NAME} user=${DB_USER} sslmode=require" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "Done. pgvector extension created."
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/db-init.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/db-init.sh
git commit -m "feat: add db-init script for post-deploy pgvector setup"
```

---

## Task 10: Deploy to test3-prod

- [ ] **Step 1: Deploy CDK stack**

```bash
source awsume test3-prod
cd infra && npx cdk deploy --require-approval broadening
```

Expected: stack creates VPC, Aurora, ECS, ALB. Docker images build and push to ECR. Takes ~15-20 minutes (Aurora provisioning is the bottleneck).

- [ ] **Step 2: Run db-init**

```bash
source awsume test3-prod
./scripts/db-init.sh
```

Expected: `CREATE EXTENSION` succeeds.

- [ ] **Step 3: Populate encryption key**

```bash
source awsume test3-prod
ENCRYPTION_KEY=$(openssl rand -hex 32)
aws secretsmanager put-secret-value \
  --secret-id polyant-secrets-dev \
  --secret-string "{\"encryption_key\":\"${ENCRYPTION_KEY}\"}" \
  --region eu-south-1
echo "Encryption key set. Restart ECS task to pick it up."
```

- [ ] **Step 4: Force new deployment to pick up the secret**

```bash
source awsume test3-prod
aws ecs update-service \
  --cluster polyant-cluster-dev \
  --service polyant-service-dev \
  --force-new-deployment \
  --region eu-south-1
```

- [ ] **Step 5: Verify deployment**

```bash
# Get ALB URL from stack outputs
ALB_URL=$(source awsume test3-prod && aws cloudformation describe-stacks \
  --stack-name polyant-dev \
  --query 'Stacks[0].Outputs[?contains(OutputKey,`AlbUrl`)].OutputValue' \
  --output text --region eu-south-1)

echo "ALB URL: $ALB_URL"

# Test health
curl "$ALB_URL/health"
# Expected: {"status":"ok","timestamp":"...","service":"polyant"}

# Test web
curl -s "$ALB_URL" | head -20
# Expected: HTML page (Next.js shell)

# Test API
curl "$ALB_URL/api/instances"
# Expected: JSON array (possibly empty)
```

- [ ] **Step 6: Commit any fixes**

If deployment required adjustments (Dockerfile tweaks, config changes), commit them:

```bash
git add -A
git commit -m "fix(infra): deployment adjustments from test3-prod validation"
```
