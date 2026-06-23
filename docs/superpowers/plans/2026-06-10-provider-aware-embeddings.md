# Provider-Aware Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let memory and knowledge work without an OpenAI key by routing embeddings through a provider-aware `embeddings-gateway` (OpenAI `text-embedding-3-small` or Bedrock `amazon.titan-embed-text-v2:0`), with a dual-column 1024/1536 schema and an opt-in re-embed migration.

**Architecture:** A new `embeddings-gateway` module mirrors the existing `ai-gateway` shape but scoped to embeddings. `resolveEmbeddingContext(instanceId)` is the single point that inspects the instance (`provider` + `embedding_dim`), looks up secrets, and returns `{ credentials, dimensions }`. `memories` and `knowledge_chunks` carry two parallel vector columns (`embedding vector(1536)`, `embedding_1024 vector(1024)`) under an XOR check constraint; an instance-scoped `embedding_dim` flag decides which column is active. The legacy `memory/embedder.ts` is deleted and every call site migrated.

**Tech Stack:** TypeScript ESM, NestJS 11, Drizzle ORM + pgvector, Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/amazon-bedrock`), `@aws-sdk/credential-providers`, Next.js 15 / React 19 (web), Vitest.

**Commit discipline:** every commit MUST be signed off — use `git commit -s`. Run commands from the worktree root unless noted.

---

## File Structure

**New (engine):**
- `packages/engine/src/embeddings-gateway/types.ts` — provider/credentials/options types
- `packages/engine/src/embeddings-gateway/config.ts` — model IDs, supported dims, default dim, `assertDimSupported`
- `packages/engine/src/embeddings-gateway/dim-columns.ts` — `vectorColumnValues` XOR helper
- `packages/engine/src/embeddings-gateway/providers/openai.ts` — OpenAI embedding calls
- `packages/engine/src/embeddings-gateway/providers/bedrock.ts` — Bedrock Titan v2 embedding calls
- `packages/engine/src/embeddings-gateway/provider-resolver.ts` — instance → context + TTL cache + invalidation
- `packages/engine/src/embeddings-gateway/index.ts` — `embed`/`embedMany` dispatch + barrel
- `packages/engine/src/embeddings-gateway/re-embed.service.ts` — batched 1536→1024 backfill
- `packages/engine/src/server/memories/memory-status.ts` — embedding readiness for the UI banner
- `packages/engine/src/server/memories/re-embed.controller.ts` — `POST /api/instances/:slug/memories/re-embed`
- `packages/engine/src/database/migrations/0043_embedding_dims_1024.sql` — schema migration
- Test files alongside each new module.

**Modified (engine):**
- `instances/schema.ts`, `instances/store.ts`, `instances/resolve-instance-id.ts`
- `memory/schema.ts`, `memory/memory-store.ts`, `memory/extractor.ts`, `memory/hybrid-search.ts`
- `knowledge/schema.ts`, `knowledge/store.ts`, `knowledge/ingestion.ts`, `knowledge/search.ts`
- `agents/tools/{save-memory,search-memory,search-knowledge,write-knowledge}.tool.ts`
- `server/memories/memories.controller.ts`, `server/instances/instances.controller.ts`, `server/server.module.ts`
- `database/migrations/meta/_journal.json`

**Deleted (engine):** `memory/embedder.ts`, `memory/embedder.test.ts`

**Modified (web):**
- `src/lib/api-types.ts`, `src/lib/api.ts`
- `src/app/(admin)/instances/[slug]/settings-tab.tsx`
- `src/lib/i18n/locales/{en,it}.json`

---

## Task 1: Gateway foundation — types, config, dim-columns

**Files:**
- Create: `packages/engine/src/embeddings-gateway/types.ts`
- Create: `packages/engine/src/embeddings-gateway/config.ts`
- Create: `packages/engine/src/embeddings-gateway/dim-columns.ts`
- Test: `packages/engine/src/embeddings-gateway/config.test.ts`, `dim-columns.test.ts`

- [ ] **Step 1: Write `types.ts`**

```ts
export type EmbeddingProvider = "openai" | "bedrock";

export type EmbeddingDim = 1024 | 1536;

export interface OpenAICredentials {
  readonly provider: "openai";
  readonly apiKey: string;
}

export interface BedrockCredentials {
  readonly provider: "bedrock";
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly region: string;
}

export type EmbeddingCredentials = OpenAICredentials | BedrockCredentials;

export interface EmbedOptions {
  readonly credentials: EmbeddingCredentials;
  readonly dimensions: EmbeddingDim;
}

export interface EmbeddingContext extends EmbedOptions {
  readonly instanceId: string;
}
```

- [ ] **Step 2: Write `config.ts`**

```ts
import type { EmbeddingProvider, EmbeddingDim } from "./types.js";

/** Model ID per provider. Both must support 1024-dim output. */
export const EMBEDDING_MODEL_IDS: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
  bedrock: "amazon.titan-embed-text-v2:0",
};

/** Dimensions supported per provider. Titan v2 cannot emit 1536-dim. */
export const SUPPORTED_DIMS: Record<EmbeddingProvider, readonly EmbeddingDim[]> = {
  openai: [1024, 1536],
  bedrock: [1024],
};

/** Default dimension for brand-new instances. */
export const DEFAULT_EMBEDDING_DIM: EmbeddingDim = 1024;

export function assertDimSupported(
  provider: EmbeddingProvider,
  dim: EmbeddingDim,
): void {
  if (!SUPPORTED_DIMS[provider].includes(dim)) {
    throw new Error(
      `Embedding provider "${provider}" does not support ${dim}-dim output. Supported: ${SUPPORTED_DIMS[provider].join(", ")}.`,
    );
  }
}
```

- [ ] **Step 3: Write `dim-columns.ts`**

```ts
import type { EmbeddingDim } from "./types.js";

/**
 * Vector-column assignment for tables that carry both 1536- and 1024-dim
 * parallel columns (memories, knowledge_chunks). Exactly one column is
 * populated per row — the one that matches the active embedding dimension —
 * and the other is explicitly nulled so the DB XOR check constraint holds.
 */
export function vectorColumnValues(
  dim: EmbeddingDim,
  embedding: number[] | null,
): { embedding: number[] | null; embedding1024: number[] | null } {
  if (dim === 1024) return { embedding: null, embedding1024: embedding };
  return { embedding, embedding1024: null };
}
```

- [ ] **Step 4: Write tests `config.test.ts` + `dim-columns.test.ts`**

```ts
// config.test.ts
import { describe, it, expect } from "vitest";
import { assertDimSupported, SUPPORTED_DIMS, DEFAULT_EMBEDDING_DIM } from "./config.js";

describe("assertDimSupported", () => {
  it("accepts supported dims", () => {
    expect(() => assertDimSupported("openai", 1536)).not.toThrow();
    expect(() => assertDimSupported("openai", 1024)).not.toThrow();
    expect(() => assertDimSupported("bedrock", 1024)).not.toThrow();
  });
  it("rejects 1536 on bedrock", () => {
    expect(() => assertDimSupported("bedrock", 1536)).toThrow(/does not support 1536/);
  });
  it("defaults new instances to 1024", () => {
    expect(DEFAULT_EMBEDDING_DIM).toBe(1024);
    expect(SUPPORTED_DIMS.bedrock).toEqual([1024]);
  });
});
```

```ts
// dim-columns.test.ts
import { describe, it, expect } from "vitest";
import { vectorColumnValues } from "./dim-columns.js";

describe("vectorColumnValues", () => {
  it("routes 1024 vectors to embedding_1024 and nulls legacy", () => {
    expect(vectorColumnValues(1024, [1, 2, 3])).toEqual({ embedding: null, embedding1024: [1, 2, 3] });
  });
  it("routes 1536 vectors to legacy column and nulls 1024", () => {
    expect(vectorColumnValues(1536, [1, 2, 3])).toEqual({ embedding: [1, 2, 3], embedding1024: null });
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm run test:unit -w @polyant/engine -- embeddings-gateway/config embeddings-gateway/dim-columns`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/embeddings-gateway/{types,config,dim-columns}.ts packages/engine/src/embeddings-gateway/*.test.ts
git commit -s -m "feat(embeddings): gateway foundation — types, config, dim-columns helper"
```

---

## Task 2: Gateway providers — OpenAI + Bedrock

**Files:**
- Create: `packages/engine/src/embeddings-gateway/providers/openai.ts`
- Create: `packages/engine/src/embeddings-gateway/providers/bedrock.ts`
- Test: `packages/engine/src/embeddings-gateway/providers/openai.test.ts`, `bedrock.test.ts`

- [ ] **Step 1: Write `providers/openai.ts`**

```ts
import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingDim } from "../types.js";
import { EMBEDDING_MODEL_IDS, assertDimSupported } from "../config.js";

interface OpenAICallOptions {
  readonly apiKey: string;
  readonly dimensions: EmbeddingDim;
}

function buildModel(apiKey: string, dimensions: EmbeddingDim) {
  if (!apiKey) {
    throw new Error(
      "OpenAI API key required for embeddings. Configure it in admin panel under Settings → AI Provider.",
    );
  }
  const provider = createOpenAI({ apiKey });
  return provider.embedding(EMBEDDING_MODEL_IDS.openai, { dimensions });
}

export async function embedOpenAI(text: string, opts: OpenAICallOptions): Promise<number[]> {
  assertDimSupported("openai", opts.dimensions);
  const model = buildModel(opts.apiKey, opts.dimensions);
  const { embedding } = await embed({ model, value: text });
  return embedding;
}

export async function embedManyOpenAI(texts: string[], opts: OpenAICallOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) {
    const single = await embedOpenAI(texts[0], opts);
    return [single];
  }
  assertDimSupported("openai", opts.dimensions);
  const model = buildModel(opts.apiKey, opts.dimensions);
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}
```

- [ ] **Step 2: Write `providers/bedrock.ts`**

```ts
import { embed, embedMany } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { EmbeddingDim } from "../types.js";
import { EMBEDDING_MODEL_IDS, assertDimSupported } from "../config.js";

interface BedrockCallOptions {
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly region: string;
  readonly dimensions: EmbeddingDim;
}

function buildModel(opts: BedrockCallOptions) {
  // Explicit per-instance credentials take precedence. Otherwise delegate to the
  // AWS SDK default provider chain (ECS task role, EC2 IMDS, SSO, shared
  // credentials) — @ai-sdk/amazon-bedrock only reads env vars by default,
  // mirroring the chat provider's resolution in ai-gateway/providers/bedrock.ts.
  const provider =
    opts.accessKeyId && opts.secretAccessKey
      ? createAmazonBedrock({
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
          region: opts.region,
        })
      : createAmazonBedrock({
          region: opts.region,
          credentialProvider: fromNodeProviderChain(),
        });
  // Titan v2 settings type only allows 256 | 512 | 1024. assertDimSupported()
  // guarantees a supported value here, but the union still includes 1536 (OpenAI),
  // so narrow with a cast.
  return provider.embedding(EMBEDDING_MODEL_IDS.bedrock, {
    dimensions: opts.dimensions as 1024,
  });
}

export async function embedBedrock(text: string, opts: BedrockCallOptions): Promise<number[]> {
  assertDimSupported("bedrock", opts.dimensions);
  const model = buildModel(opts);
  const { embedding } = await embed({ model, value: text });
  return embedding;
}

export async function embedManyBedrock(texts: string[], opts: BedrockCallOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) {
    const single = await embedBedrock(texts[0], opts);
    return [single];
  }
  assertDimSupported("bedrock", opts.dimensions);
  const model = buildModel(opts);
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}
```

- [ ] **Step 3: Write tests** (mock the AI SDK modules; assert model id, dimensions param, and empty/single/batch behavior)

```ts
// openai.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const embedMock = vi.fn();
const embedManyMock = vi.fn();
vi.mock("ai", () => ({
  embed: (...a: unknown[]) => embedMock(...a),
  embedMany: (...a: unknown[]) => embedManyMock(...a),
}));
const embeddingFactory = vi.fn(() => "MODEL");
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ embedding: embeddingFactory }),
}));

import { embedOpenAI, embedManyOpenAI } from "./openai.js";

beforeEach(() => {
  embedMock.mockReset().mockResolvedValue({ embedding: [0.1, 0.2] });
  embedManyMock.mockReset().mockResolvedValue({ embeddings: [[0.1], [0.2]] });
  embeddingFactory.mockClear();
});

describe("embedOpenAI", () => {
  it("passes the configured dimensions to the model factory", async () => {
    await embedOpenAI("hi", { apiKey: "k", dimensions: 1024 });
    expect(embeddingFactory).toHaveBeenCalledWith("text-embedding-3-small", { dimensions: 1024 });
  });
  it("throws without an api key", async () => {
    await expect(embedOpenAI("hi", { apiKey: "", dimensions: 1024 })).rejects.toThrow(/OpenAI API key/);
  });
});

describe("embedManyOpenAI", () => {
  it("returns [] for empty input without calling the SDK", async () => {
    expect(await embedManyOpenAI([], { apiKey: "k", dimensions: 1024 })).toEqual([]);
    expect(embedManyMock).not.toHaveBeenCalled();
  });
  it("uses embedMany for >1 text", async () => {
    const out = await embedManyOpenAI(["a", "b"], { apiKey: "k", dimensions: 1024 });
    expect(out).toEqual([[0.1], [0.2]]);
  });
});
```

```ts
// bedrock.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const embedMock = vi.fn();
vi.mock("ai", () => ({ embed: (...a: unknown[]) => embedMock(...a), embedMany: vi.fn() }));
const embeddingFactory = vi.fn(() => "MODEL");
const createBedrock = vi.fn(() => ({ embedding: embeddingFactory }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: (...a: unknown[]) => createBedrock(...a) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => "CHAIN" }));

import { embedBedrock } from "./bedrock.js";

beforeEach(() => {
  embedMock.mockReset().mockResolvedValue({ embedding: [0.1] });
  createBedrock.mockClear();
  embeddingFactory.mockClear();
});

describe("embedBedrock", () => {
  it("uses Titan v2 with 1024 dims and explicit creds when provided", async () => {
    await embedBedrock("hi", { accessKeyId: "id", secretAccessKey: "sec", region: "eu-west-1", dimensions: 1024 });
    expect(createBedrock).toHaveBeenCalledWith(expect.objectContaining({ accessKeyId: "id", region: "eu-west-1" }));
    expect(embeddingFactory).toHaveBeenCalledWith("amazon.titan-embed-text-v2:0", { dimensions: 1024 });
  });
  it("falls back to the AWS provider chain without explicit creds", async () => {
    await embedBedrock("hi", { region: "eu-west-1", dimensions: 1024 });
    expect(createBedrock).toHaveBeenCalledWith(expect.objectContaining({ credentialProvider: "CHAIN" }));
  });
  it("rejects 1536 dims", async () => {
    await expect(embedBedrock("hi", { region: "eu-west-1", dimensions: 1536 })).rejects.toThrow(/does not support 1536/);
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
npm run test:unit -w @polyant/engine -- embeddings-gateway/providers
git add packages/engine/src/embeddings-gateway/providers
git commit -s -m "feat(embeddings): OpenAI + Bedrock Titan v2 embedding providers"
```

---

## Task 3: Instance lookup helpers + provider-resolver

`resolveEmbeddingContext` and `memory-status` need to load a full `Instance` by id OR slug. Polyant's `resolve-instance-id.ts` only has `resolveInstanceId`/`resolveInstanceSlug`; add `findInstanceById` to the store and `findInstanceByIdOrSlug` to the resolver first.

**Files:**
- Modify: `packages/engine/src/instances/store.ts`
- Modify: `packages/engine/src/instances/resolve-instance-id.ts`
- Create: `packages/engine/src/embeddings-gateway/provider-resolver.ts`
- Test: `packages/engine/src/embeddings-gateway/provider-resolver.test.ts`

- [ ] **Step 1: Add `embeddingDim` to the `Instance` interface** (`instances/store.ts`)

In `export interface Instance { ... }`, add after `sttProvider: string;`:

```ts
  embeddingDim: number;
```

- [ ] **Step 2: Add `findInstanceById` to `instances/store.ts`** (after `findInstanceBySlug`)

```ts
/** Find an instance by id (UUID). Returns undefined if not found. */
export async function findInstanceById(id: string): Promise<Instance | undefined> {
  const rows = await db.select().from(instances).where(eq(instances.id, id)).limit(1);
  return rows[0];
}
```

- [ ] **Step 3: Seed `embeddingDim` on instance creation** (`instances/store.ts`)

Add at the top imports: `import { DEFAULT_EMBEDDING_DIM } from "../embeddings-gateway/config.js";`
In `ensureInstance(...)` `.values({...})` add `embeddingDim: DEFAULT_EMBEDDING_DIM,`.
In `createInstance(...)` `.values({...})` add (with comment) `embeddingDim: DEFAULT_EMBEDDING_DIM,` — *new instances default to 1024d; the DB default (1536) stays for legacy rows.*

- [ ] **Step 4: Add `findInstanceByIdOrSlug` to `resolve-instance-id.ts`**

```ts
import { findInstanceById, findInstanceBySlug } from "./store.js";
import type { Instance } from "./store.js";

/**
 * Resolve an instance by either its UUID or its slug. Tries id first when the
 * value looks like a UUID, otherwise slug; falls back to the other form so a
 * caller passing either alias always succeeds. Returns undefined if not found.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function findInstanceByIdOrSlug(idOrSlug: string): Promise<Instance | undefined> {
  if (UUID_RE.test(idOrSlug)) {
    return (await findInstanceById(idOrSlug)) ?? (await findInstanceBySlug(idOrSlug));
  }
  return (await findInstanceBySlug(idOrSlug)) ?? (await findInstanceById(idOrSlug));
}
```

- [ ] **Step 5: Write `provider-resolver.ts`**

```ts
import type { EmbeddingContext, EmbeddingDim } from "./types.js";
import { findInstanceByIdOrSlug } from "../instances/resolve-instance-id.js";
import { getAllSecretsById, SECRET_KEYS } from "../instances/secrets.store.js";
import { TtlCache } from "../utils/ttl-cache.js";

function assertDim(dim: number): EmbeddingDim {
  if (dim !== 1024 && dim !== 1536) {
    throw new Error(`Unsupported instance.embedding_dim ${dim} (expected 1024 or 1536).`);
  }
  return dim;
}

// Hot-path cache keyed by the raw lookup value (id or slug); 30 s TTL matches
// config-resolver. Manual invalidation is wired into secret/instance mutations.
const cache = new TtlCache<string, EmbeddingContext>({ maxSize: 200, ttlMs: 30_000 });

/** Clear cached embedding contexts for an instance. Pass all known aliases (id and slug). */
export function invalidateEmbeddingContext(...aliases: string[]): void {
  for (const alias of aliases) {
    if (alias) cache.delete(alias);
  }
}

/** Invalidate every cached embedding context. */
export function invalidateAllEmbeddingContexts(): void {
  cache.clear();
}

/**
 * Resolve the embedding provider + credentials + dimensions for an instance.
 * Accepts either the instance UUID or slug.
 */
export async function resolveEmbeddingContext(instanceIdOrSlug: string): Promise<EmbeddingContext> {
  const cached = cache.get(instanceIdOrSlug);
  if (cached) return cached;

  const instance = await findInstanceByIdOrSlug(instanceIdOrSlug);
  if (!instance) {
    throw new Error(`Instance "${instanceIdOrSlug}" not found.`);
  }

  const dimensions = assertDim(instance.embeddingDim);
  const secrets = await getAllSecretsById(instance.id);
  const provider = instance.provider ?? "openai";

  let ctx: EmbeddingContext;
  if (provider === "bedrock") {
    // Per-instance secret wins; otherwise fall back to AWS_REGION on the engine.
    const region = secrets[SECRET_KEYS.AWS_REGION] ?? process.env.AWS_REGION;
    if (!region) {
      throw new Error(
        `AWS region is required for Bedrock embeddings on instance "${instance.slug}". Set AWS_REGION on the engine, or configure aws_region in Settings → AI Provider.`,
      );
    }
    ctx = {
      instanceId: instance.id,
      dimensions,
      credentials: {
        provider: "bedrock",
        accessKeyId: secrets[SECRET_KEYS.AWS_ACCESS_KEY_ID],
        secretAccessKey: secrets[SECRET_KEYS.AWS_SECRET_ACCESS_KEY],
        region,
      },
    };
  } else {
    // openai + anthropic-fallback → OpenAI
    const apiKey = secrets[SECRET_KEYS.OPENAI_API_KEY];
    if (!apiKey) {
      throw new Error(
        `OpenAI API key required for embeddings on instance "${instance.slug}". Configure it in Settings → AI Provider.`,
      );
    }
    ctx = { instanceId: instance.id, dimensions, credentials: { provider: "openai", apiKey } };
  }

  cache.set(instanceIdOrSlug, ctx);
  return ctx;
}
```

> Note: `process.env.AWS_REGION` is read here intentionally (mirrors `ai-gateway/providers/bedrock.ts`). Mark it with a `// CONVENTION-EXCEPTION:` comment per the config rule in CLAUDE.md.

> Verify `TtlCache` exposes `clear()`. If missing, add `clear(): void { this.map.clear(); }` to `utils/ttl-cache.ts`.

- [ ] **Step 6: Write `provider-resolver.test.ts`** (mock `findInstanceByIdOrSlug` + `getAllSecretsById`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findInstance = vi.fn();
const getSecrets = vi.fn();
vi.mock("../instances/resolve-instance-id.js", () => ({ findInstanceByIdOrSlug: (...a: unknown[]) => findInstance(...a) }));
vi.mock("../instances/secrets.store.js", () => ({
  getAllSecretsById: (...a: unknown[]) => getSecrets(...a),
  SECRET_KEYS: { OPENAI_API_KEY: "openai_api_key", AWS_REGION: "aws_region", AWS_ACCESS_KEY_ID: "aws_access_key_id", AWS_SECRET_ACCESS_KEY: "aws_secret_access_key" },
}));

import { resolveEmbeddingContext, invalidateAllEmbeddingContexts } from "./provider-resolver.js";

beforeEach(() => {
  findInstance.mockReset();
  getSecrets.mockReset().mockResolvedValue({});
  invalidateAllEmbeddingContexts();
});

describe("resolveEmbeddingContext", () => {
  it("resolves openai with key", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "openai", embeddingDim: 1536 });
    getSecrets.mockResolvedValue({ openai_api_key: "k" });
    const ctx = await resolveEmbeddingContext("s");
    expect(ctx.credentials).toEqual({ provider: "openai", apiKey: "k" });
    expect(ctx.dimensions).toBe(1536);
  });
  it("throws when openai key missing", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "openai", embeddingDim: 1024 });
    await expect(resolveEmbeddingContext("s")).rejects.toThrow(/OpenAI API key required/);
  });
  it("resolves bedrock with region from secrets", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "bedrock", embeddingDim: 1024 });
    getSecrets.mockResolvedValue({ aws_region: "eu-west-1" });
    const ctx = await resolveEmbeddingContext("s");
    expect(ctx.credentials.provider).toBe("bedrock");
    expect(ctx.dimensions).toBe(1024);
  });
  it("falls anthropic back to openai", async () => {
    findInstance.mockResolvedValue({ id: "i1", slug: "s", provider: "anthropic", embeddingDim: 1024 });
    getSecrets.mockResolvedValue({ openai_api_key: "k" });
    const ctx = await resolveEmbeddingContext("s");
    expect(ctx.credentials.provider).toBe("openai");
  });
  it("throws on unknown instance", async () => {
    findInstance.mockResolvedValue(undefined);
    await expect(resolveEmbeddingContext("nope")).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 7: Run + commit**

```bash
npm run test:unit -w @polyant/engine -- embeddings-gateway/provider-resolver instances/store
git add packages/engine/src/instances/store.ts packages/engine/src/instances/resolve-instance-id.ts packages/engine/src/embeddings-gateway/provider-resolver.ts packages/engine/src/embeddings-gateway/provider-resolver.test.ts
git commit -s -m "feat(embeddings): per-instance provider resolver with TTL cache"
```

---

## Task 4: Gateway barrel (`index.ts`)

**Files:**
- Create: `packages/engine/src/embeddings-gateway/index.ts`
- Test: `packages/engine/src/embeddings-gateway/index.test.ts`

- [ ] **Step 1: Write `index.ts`**

```ts
import type { EmbedOptions } from "./types.js";
import { embedOpenAI, embedManyOpenAI } from "./providers/openai.js";
import { embedBedrock, embedManyBedrock } from "./providers/bedrock.js";

export async function embed(text: string, opts: EmbedOptions): Promise<number[]> {
  const { credentials, dimensions } = opts;
  if (credentials.provider === "openai") {
    return embedOpenAI(text, { apiKey: credentials.apiKey, dimensions });
  }
  return embedBedrock(text, {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    dimensions,
  });
}

export async function embedMany(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const { credentials, dimensions } = opts;
  if (credentials.provider === "openai") {
    return embedManyOpenAI(texts, { apiKey: credentials.apiKey, dimensions });
  }
  return embedManyBedrock(texts, {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    dimensions,
  });
}

export type {
  EmbeddingProvider,
  EmbeddingCredentials,
  EmbedOptions,
  EmbeddingContext,
  EmbeddingDim,
  OpenAICredentials,
  BedrockCredentials,
} from "./types.js";

export { resolveEmbeddingContext } from "./provider-resolver.js";
```

- [ ] **Step 2: Write `index.test.ts`** (mock both providers, assert dispatch by `credentials.provider`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const oa = vi.fn(); const oaMany = vi.fn(); const br = vi.fn(); const brMany = vi.fn();
vi.mock("./providers/openai.js", () => ({ embedOpenAI: (...a: unknown[]) => oa(...a), embedManyOpenAI: (...a: unknown[]) => oaMany(...a) }));
vi.mock("./providers/bedrock.js", () => ({ embedBedrock: (...a: unknown[]) => br(...a), embedManyBedrock: (...a: unknown[]) => brMany(...a) }));
vi.mock("./provider-resolver.js", () => ({ resolveEmbeddingContext: vi.fn() }));
import { embed, embedMany } from "./index.js";
beforeEach(() => { oa.mockReset().mockResolvedValue([1]); br.mockReset().mockResolvedValue([2]); });
describe("embed dispatch", () => {
  it("routes openai", async () => {
    await embed("x", { credentials: { provider: "openai", apiKey: "k" }, dimensions: 1024 });
    expect(oa).toHaveBeenCalled(); expect(br).not.toHaveBeenCalled();
  });
  it("routes bedrock", async () => {
    await embed("x", { credentials: { provider: "bedrock", region: "eu-west-1" }, dimensions: 1024 });
    expect(br).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
npm run test:unit -w @polyant/engine -- embeddings-gateway/index
git add packages/engine/src/embeddings-gateway/index.ts packages/engine/src/embeddings-gateway/index.test.ts
git commit -s -m "feat(embeddings): gateway barrel with provider dispatch"
```

---

## Task 5: Schema + migration (dual-column + instance flag)

**Files:**
- Modify: `packages/engine/src/memory/schema.ts`
- Modify: `packages/engine/src/knowledge/schema.ts`
- Modify: `packages/engine/src/instances/schema.ts`
- Create: `packages/engine/src/database/migrations/0043_embedding_dims_1024.sql`
- Modify: `packages/engine/src/database/migrations/meta/_journal.json`

- [ ] **Step 1: `memory/schema.ts`** — import `check` from `drizzle-orm/pg-core` and `sql` from `drizzle-orm`; make `embedding` nullable; add columns + XOR check.

Replace the `embedding` column line:
```ts
    embedding: vector("embedding", { dimensions: 1536 }),
    embedding1024: vector("embedding_1024", { dimensions: 1024 }),
    embeddingProvider: text("embedding_provider"),
```
Add to the table's index array:
```ts
    check(
      "memories_embedding_xor",
      sql`(${table.embedding} IS NULL) <> (${table.embedding1024} IS NULL)`,
    ),
```

- [ ] **Step 2: `knowledge/schema.ts`** — same treatment for `knowledgeChunks` (import `check` + `sql`; make `embedding` nullable; add `embedding1024` + `embeddingProvider`; add `knowledge_chunks_embedding_xor` check).

- [ ] **Step 3: `instances/schema.ts`** — add `integer` to the pg-core import and a column after `sttProvider`:
```ts
  embeddingDim: integer("embedding_dim").notNull().default(1536),
```

- [ ] **Step 4: Write migration `0043_embedding_dims_1024.sql`** (hand-written per the drizzle-kit ESM caveat)

```sql
-- 0043_embedding_dims_1024.sql
-- Add parallel 1024-dim embedding columns to memories and knowledge_chunks,
-- plus a per-instance dim flag. Existing 1536-dim rows are preserved via a
-- nullable XOR relationship with the new column.

BEGIN;

ALTER TABLE "memories" ADD COLUMN "embedding_1024" vector(1024);
ALTER TABLE "memories" ADD COLUMN "embedding_provider" text;
ALTER TABLE "memories" ALTER COLUMN "embedding" DROP NOT NULL;
ALTER TABLE "memories"
  ADD CONSTRAINT "memories_embedding_xor"
  CHECK (("embedding" IS NULL) <> ("embedding_1024" IS NULL));
CREATE INDEX IF NOT EXISTS "idx_memories_embedding_1024_cosine"
  ON "memories" USING hnsw ("embedding_1024" vector_cosine_ops);

ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_1024" vector(1024);
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_provider" text;
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" DROP NOT NULL;
ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_embedding_xor"
  CHECK (("embedding" IS NULL) <> ("embedding_1024" IS NULL));
CREATE INDEX IF NOT EXISTS "idx_knowledge_chunks_embedding_1024_cosine"
  ON "knowledge_chunks" USING hnsw ("embedding_1024" vector_cosine_ops);

ALTER TABLE "instances"
  ADD COLUMN "embedding_dim" integer NOT NULL DEFAULT 1536;

COMMIT;
```

- [ ] **Step 5: Append the migration to `meta/_journal.json`** — add a new entry with `idx` incremented from the last, `version` matching sibling entries, a `when` epoch (copy the format of the previous entry; the exact timestamp value is not load-bearing), and `tag: "0043_embedding_dims_1024"`.

- [ ] **Step 6: Verify schema compiles + apply migration**

```bash
npm run typecheck -w @polyant/engine
docker compose up -d   # ensure postgres is running
npm run db:migrate -w @polyant/engine
```
Expected: typecheck clean; migration applies; `\d memories` shows `embedding_1024`, `embedding_provider`, and the XOR constraint.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/memory/schema.ts packages/engine/src/knowledge/schema.ts packages/engine/src/instances/schema.ts packages/engine/src/database/migrations/0043_embedding_dims_1024.sql packages/engine/src/database/migrations/meta/_journal.json
git commit -s -m "feat(db): dual 1024/1536 embedding columns + per-instance embedding_dim (migration 0043)"
```

---

## Task 6: Column-aware memory store

**Files:**
- Modify: `packages/engine/src/memory/memory-store.ts`
- Test: `packages/engine/src/memory/memory-store.test.ts`

- [ ] **Step 1: Imports + types** — add:
```ts
import type { EmbeddingDim, EmbeddingProvider } from "../embeddings-gateway/types.js";
import { vectorColumnValues } from "../embeddings-gateway/dim-columns.js";
```
Extend `InsertMemoryInput` with:
```ts
  /** Dimension of `embedding` — chooses DB column. */
  dimensions: EmbeddingDim;
  /** Provider that produced the embedding. Stored as `embedding_provider`. */
  provider: EmbeddingProvider;
```

- [ ] **Step 2: Active-column helper** (near the other private helpers)
```ts
/** Pick the active Drizzle column based on dim. */
function activeEmbeddingColumn(dim: EmbeddingDim) {
  return dim === 1024 ? memories.embedding1024 : memories.embedding;
}
```

- [ ] **Step 3: Use the active column in `runUpsertMemoryTx`** — compute `const activeCol = activeEmbeddingColumn(input.dimensions);` and use it in `cosineDistance(activeCol, input.embedding)`. Compute `const vectorCols = vectorColumnValues(input.dimensions, input.embedding);` and, in both the UPDATE `.set({...})` and the INSERT `.values({...})`, replace `embedding: input.embedding` with `...vectorCols, embeddingProvider: input.provider,`.

- [ ] **Step 4: `searchByVector` takes a `dimensions` arg**
```ts
export async function searchByVector(
  queryEmbedding: number[],
  instanceId: string,
  limit = 10,
  dimensions: EmbeddingDim,
): Promise<Array<MemoryRecord & { similarity: number }>> {
  const activeCol = activeEmbeddingColumn(dimensions);
  const distance = cosineDistance(activeCol, queryEmbedding);
  // ...rest unchanged
}
```

- [ ] **Step 5: Update `memory-store.test.ts`** — every `upsertMemory`/`InsertMemoryInput` fixture gains `dimensions` + `provider`; add a case asserting that `dimensions: 1024` writes to `embedding_1024` (null `embedding`) and `1536` writes to `embedding` (null `embedding_1024`); `searchByVector` calls pass a `dimensions` arg.

- [ ] **Step 6: Run + commit**
```bash
npm run test:unit -w @polyant/engine -- memory/memory-store
git add packages/engine/src/memory/memory-store.ts packages/engine/src/memory/memory-store.test.ts
git commit -s -m "feat(memory): column-aware store keyed by embedding dimension"
```

---

## Task 7: Column-aware knowledge store

**Files:**
- Modify: `packages/engine/src/knowledge/store.ts`
- Test: `packages/engine/src/knowledge/store.test.ts`

- [ ] **Step 1: Imports** — add `EmbeddingDim`, `EmbeddingProvider` types and `vectorColumnValues` (same as memory store).

- [ ] **Step 2: Helpers + typed input**
```ts
/** Pick the active Drizzle column based on embedding dim. */
function activeKnowledgeChunkColumn(dim: EmbeddingDim) {
  return dim === 1024 ? knowledgeChunks.embedding1024 : knowledgeChunks.embedding;
}

export interface InsertChunkInput {
  documentId: string;
  instanceId: string;
  content: string;
  embedding: number[];
  chunkIndex: number;
}

/** Build row values for a chunk insert — populates the active column, NULLs the other. */
function chunkRowValues(c: InsertChunkInput, dimensions: EmbeddingDim, provider: EmbeddingProvider) {
  return {
    documentId: c.documentId,
    instanceId: c.instanceId,
    content: c.content,
    ...vectorColumnValues(dimensions, c.embedding),
    embeddingProvider: provider,
    chunkIndex: c.chunkIndex,
  };
}
```

- [ ] **Step 3: `insertChunks` + `insertChunksAndFinalize`** — change both signatures to `(chunks: InsertChunkInput[], dimensions: EmbeddingDim, provider: EmbeddingProvider)` and map rows through `chunkRowValues(c, dimensions, provider)` (both the plain insert and the transactional one).

- [ ] **Step 4: `searchByVector`** — add `dimensions: EmbeddingDim` param; use `activeKnowledgeChunkColumn(dimensions)` for `cosineDistance`.

- [ ] **Step 5: Update `knowledge/store.test.ts`** — insert fixtures pass `dimensions` + `provider`; `searchByVector` passes `dimensions`; add a 1024-vs-1536 column-routing assertion.

- [ ] **Step 6: Run + commit**
```bash
npm run test:unit -w @polyant/engine -- knowledge/store
git add packages/engine/src/knowledge/store.ts packages/engine/src/knowledge/store.test.ts
git commit -s -m "feat(knowledge): column-aware chunk store keyed by embedding dimension"
```

---

## Task 8: Call-site refactor + delete legacy embedder

Migrate every embedding caller to the gateway; delete `memory/embedder.ts`.

**Files:**
- Modify: `memory/extractor.ts`, `memory/hybrid-search.ts`, `knowledge/ingestion.ts`, `knowledge/search.ts`
- Modify: `agents/tools/{save-memory,search-memory,search-knowledge,write-knowledge}.tool.ts`
- Modify: `server/memories/memories.controller.ts`
- Delete: `memory/embedder.ts`, `memory/embedder.test.ts`
- Test: update the affected tests (`extractor.test.ts`, `hybrid-search.test.ts`, memory/knowledge tool tests)

- [ ] **Step 1: `memory/extractor.ts`** — replace `import { generateEmbeddings } from "./embedder.js";` with `import { embedMany, resolveEmbeddingContext } from "../embeddings-gateway/index.js";`. Replace the embedding block:
```ts
  const contents = facts.map((f) => f.content);
  const ctx = await resolveEmbeddingContext(instanceId);
  const embeddings = await embedMany(contents, ctx);
```
Add `dimensions: ctx.dimensions, provider: ctx.credentials.provider,` to each `upsertMemory({...})` call.

- [ ] **Step 2: `memory/hybrid-search.ts`** — swap import to the gateway; drop the `openaiApiKey` param from `hybridSearch`; resolve `ctx` from `uid`, embed the query via `embed(query, ctx)`, and pass `ctx.dimensions` to `searchByVector(queryEmbedding, uid, fetchLimit, ctx.dimensions)`.

- [ ] **Step 3: `knowledge/ingestion.ts`** — swap import to the gateway; drop `openaiApiKey` from `processDocument`; resolve `ctx` once, call `embedMany(batch.map(c => c.content), ctx)`, and call `insertChunksAndFinalize(docId, chunkRecords, ctx.dimensions, ctx.credentials.provider)`.

- [ ] **Step 4: `knowledge/search.ts`** — swap import; drop `openaiApiKey`; `const ctx = await resolveEmbeddingContext(instanceId); const queryEmbedding = await embed(query, ctx); return searchByVector(queryEmbedding, instanceId, limit, ctx.dimensions);`.

- [ ] **Step 5: tools** —
  - `save-memory.tool.ts`: swap to gateway; `const embCtx = await resolveEmbeddingContext(ctx.instanceId); const embedding = await embed(content, embCtx);` and add `dimensions: embCtx.dimensions, provider: embCtx.credentials.provider,` to `upsertMemory`.
  - `search-memory.tool.ts`: drop the `openaiKey` arg from the `hybridSearch(...)` call.
  - `search-knowledge.tool.ts`: drop the `openaiKey` arg from `searchKnowledge(...)`.
  - `write-knowledge.tool.ts`: drop `openaiKey`; call `processDocument(docId, ctx.instanceId, rawContent)`.

- [ ] **Step 6: `server/memories/memories.controller.ts`** — remove the `generateEmbeddings` + `getAllSecretsById` imports; add `import { embedMany, resolveEmbeddingContext } from "../../embeddings-gateway/index.js";`. Replace the manual OpenAI-key check + embed with:
```ts
    const embCtx = await resolveEmbeddingContext(uid).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Embedding provider not configured.";
      throw new BadRequestException(message);
    });
    const [embedding] = await embedMany([body.content], embCtx);
```
and add `dimensions: embCtx.dimensions, provider: embCtx.credentials.provider,` to the `upsertMemory({...})` call.

- [ ] **Step 7: Find any stragglers + delete the legacy embedder**
```bash
grep -rn "memory/embedder\|generateEmbedding\b\|generateEmbeddings\b" packages/engine/src
```
Migrate any remaining caller, then:
```bash
git rm packages/engine/src/memory/embedder.ts packages/engine/src/memory/embedder.test.ts
```

- [ ] **Step 8: Update affected tests** — `extractor.test.ts`, `hybrid-search.test.ts`, and tool tests: replace `generateEmbedding(s)` mocks with mocks of `../embeddings-gateway/index.js` (`embed`, `embedMany`, `resolveEmbeddingContext` returning `{ instanceId, dimensions: 1024, credentials: { provider: "openai", apiKey: "k" } }`).

- [ ] **Step 9: Run full engine unit suite + commit**
```bash
npm run test:unit -w @polyant/engine
git add -A packages/engine/src
git commit -s -m "refactor(embeddings): route all callers through the gateway; remove legacy embedder"
```

---

## Task 9: Re-embed service + controller + wiring

**Files:**
- Create: `packages/engine/src/embeddings-gateway/re-embed.service.ts`
- Create: `packages/engine/src/server/memories/re-embed.controller.ts`
- Modify: `packages/engine/src/server/server.module.ts`
- Test: `packages/engine/src/embeddings-gateway/re-embed.service.test.ts`

- [ ] **Step 1: Write `re-embed.service.ts`** (verbatim)

```ts
import { eq, and, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { memories } from "../memory/schema.js";
import { instances } from "../instances/schema.js";
import { embedMany, resolveEmbeddingContext } from "./index.js";
import type { EmbeddingContext } from "./types.js";

const BATCH_SIZE = 50;
const MAX_FAILURE_BUDGET = BATCH_SIZE * 3;
const BACKOFF_MS = 500;

/**
 * Extract a safe message from an unknown error. Bedrock's ValidationException
 * echoes the full input array (user memory content — potential PII) in its
 * payload, so we surface only `.message`, never the raw error object.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

export interface ReEmbedResult {
  readonly instanceId: string;
  readonly migrated: number;
  readonly failed: number;
  readonly dimFlipped: boolean;
}

/**
 * Re-embed every memory still on the legacy 1536-dim column into embedding_1024,
 * then flip the instance's embedding_dim flag once all rows are migrated.
 * Idempotent: candidates are rows with non-null `embedding` and null `embedding_1024`.
 */
export async function reEmbedInstance(instanceId: string): Promise<ReEmbedResult> {
  const ctx = await resolveEmbeddingContext(instanceId);
  const forceCtx: EmbeddingContext = { ...ctx, dimensions: 1024 as const };

  let migrated = 0;
  let failed = 0;

  while (true) {
    const rows = await db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(
        and(
          eq(memories.instanceId, ctx.instanceId),
          isNotNull(memories.embedding),
          isNull(memories.embedding1024),
        ),
      )
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    try {
      const contents = rows.map((r) => r.content);
      const embeddings = await embedMany(contents, forceCtx);

      await db.transaction(async (tx) => {
        const whenClauses = sql.join(
          rows.map((r, i) => sql`WHEN ${r.id}::uuid THEN ${JSON.stringify(embeddings[i])}::vector`),
          sql` `,
        );
        const idList = sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `);
        await tx.execute(sql`
          UPDATE memories
          SET embedding = NULL,
              embedding_1024 = CASE id ${whenClauses} END,
              embedding_provider = ${forceCtx.credentials.provider},
              updated_at = NOW()
          WHERE id IN (${idList})
        `);
      });
      migrated += rows.length;
    } catch (err) {
      console.error(`[re-embed] batch failed for ${ctx.instanceId}: ${errorMessage(err)}`);
      failed += rows.length;
      if (failed >= MAX_FAILURE_BUDGET) break;
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }

  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(memories)
    .where(and(eq(memories.instanceId, ctx.instanceId), isNotNull(memories.embedding)));

  let dimFlipped = false;
  if (Number(remaining) === 0) {
    await db.update(instances).set({ embeddingDim: 1024, updatedAt: new Date() }).where(eq(instances.id, ctx.instanceId));
    dimFlipped = true;
  }

  return { instanceId: ctx.instanceId, migrated, failed, dimFlipped };
}
```

- [ ] **Step 2: Write `re-embed.controller.ts`** (verbatim)

```ts
import { Controller, Post, Param, HttpCode, HttpStatus, NotFoundException } from "@nestjs/common";
import { reEmbedInstance } from "../../embeddings-gateway/re-embed.service.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";

/**
 * Triggers a background re-embedding job migrating an instance's legacy 1536-dim
 * memories to the 1024-dim column. Returns 202 immediately — progress is visible
 * via logs and the instance's `embeddingDim` flag.
 */
@Controller("api/instances")
export class ReEmbedController {
  @Post(":slug/memories/re-embed")
  @HttpCode(HttpStatus.ACCEPTED)
  async reEmbed(@Param("slug") slug: string): Promise<{ accepted: true; slug: string }> {
    const instanceId = await resolveInstanceId(slug);
    if (!instanceId) {
      throw new NotFoundException(`Instance "${slug}" not found`);
    }
    setImmediate(() => {
      reEmbedInstance(instanceId).catch((err) => {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error(`[re-embed] background job failed for ${slug}: ${message}`);
      });
    });
    return { accepted: true, slug };
  }
}
```

- [ ] **Step 3: Wire `ReEmbedController` in `server/server.module.ts`** — add the import and add `ReEmbedController` to the `controllers: [...]` array (right after `MemoriesController`).

- [ ] **Step 4: Write `re-embed.service.test.ts`** — mock `db`, `embedMany`, and `resolveEmbeddingContext`. Assert: (a) idempotency — zero legacy rows ⇒ `migrated:0` and `dimFlipped:true`; (b) a batch that throws increments `failed` and does not flip the flag while legacy rows remain; (c) the flag flips only when the post-loop remaining count is 0.

- [ ] **Step 5: Run + commit**
```bash
npm run test:unit -w @polyant/engine -- embeddings-gateway/re-embed
git add packages/engine/src/embeddings-gateway/re-embed.service.ts packages/engine/src/embeddings-gateway/re-embed.service.test.ts packages/engine/src/server/memories/re-embed.controller.ts packages/engine/src/server/server.module.ts
git commit -s -m "feat(embeddings): opt-in re-embed job + POST /api/instances/:slug/memories/re-embed"
```

---

## Task 10: Memory status + instance DTO + cache invalidation

**Files:**
- Create: `packages/engine/src/server/memories/memory-status.ts`
- Modify: `packages/engine/src/server/instances/instances.controller.ts`
- Test: `packages/engine/src/server/memories/memory-status.test.ts`

- [ ] **Step 1: Write `memory-status.ts`** (verbatim)

```ts
import type { Instance } from "../../instances/store.js";
import { findInstanceByIdOrSlug } from "../../instances/resolve-instance-id.js";
import { getAllSecretsById, SECRET_KEYS } from "../../instances/secrets.store.js";

/**
 * Embedding-pipeline readiness for an instance's memory feature.
 * - `needsOpenAIKey`: memory is ON but the configured embedding path is unusable.
 * - `canEnable`: the embedding pipeline is ready.
 * Memory OFF always reports both false (no banner).
 */
export interface MemoryStatus {
  readonly needsOpenAIKey: boolean;
  readonly canEnable: boolean;
}

const OFF: MemoryStatus = { needsOpenAIKey: false, canEnable: false };

/** Core logic given a loaded Instance (avoids a second DB round trip). */
export async function computeMemoryStatusFromInstance(instance: Instance): Promise<MemoryStatus> {
  if (!instance.memoryEnabled) return OFF;
  const secrets = await getAllSecretsById(instance.id);
  const provider = instance.provider ?? "openai";
  if (provider === "bedrock") {
    const hasRegion = !!secrets[SECRET_KEYS.AWS_REGION];
    return { needsOpenAIKey: !hasRegion, canEnable: hasRegion };
  }
  const hasOpenAIKey = !!secrets[SECRET_KEYS.OPENAI_API_KEY];
  return { needsOpenAIKey: !hasOpenAIKey, canEnable: hasOpenAIKey };
}

/** Derive memory embedding status by instance id or slug. */
export async function computeMemoryStatus(instanceIdOrSlug: string): Promise<MemoryStatus> {
  const instance = await findInstanceByIdOrSlug(instanceIdOrSlug);
  if (!instance) return OFF;
  return computeMemoryStatusFromInstance(instance);
}
```

- [ ] **Step 2: `instances.controller.ts`** — add imports:
```ts
import { invalidateEmbeddingContext } from "../../embeddings-gateway/provider-resolver.js";
import { computeMemoryStatusFromInstance } from "../memories/memory-status.js";
```
In `toInstanceDto(instance)` add `embeddingDim: instance.embeddingDim,`. In the GET-by-slug handler, return `{ instance: { ...toInstanceDto(instance), memory: await computeMemoryStatusFromInstance(instance) } }`. In the PATCH handler, after `invalidateInstanceConfigCache(slug)` add `invalidateEmbeddingContext(instance.id, slug);` and likewise return the freshly-computed `memory` status in the response.

- [ ] **Step 3: Write `memory-status.test.ts`** — mock `getAllSecretsById`: assert memory-off ⇒ OFF; bedrock + region ⇒ `{needsOpenAIKey:false, canEnable:true}`; bedrock no region ⇒ `{true,false}`; openai with key ⇒ `{false,true}`; openai/anthropic no key ⇒ `{true,false}`.

- [ ] **Step 4: Run + commit**
```bash
npm run test:unit -w @polyant/engine -- memory-status
git add packages/engine/src/server/memories/memory-status.ts packages/engine/src/server/memories/memory-status.test.ts packages/engine/src/server/instances/instances.controller.ts
git commit -s -m "feat(memory): surface embedding readiness + embeddingDim on instance DTO"
```

---

## Task 11: Web — conditional banner + re-embed migration prompt

**Files:**
- Modify: `packages/web/src/lib/api-types.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx`
- Modify: `packages/web/src/lib/i18n/locales/en.json`, `it.json`

- [ ] **Step 1: `api-types.ts`** — on the `Instance` interface add optional `embeddingDim?: number;` and:
```ts
  memory?: {
    needsOpenAIKey: boolean;
    canEnable: boolean;
  };
```

- [ ] **Step 2: `api.ts`** — add to the `memories` group of the `api` object:
```ts
    reEmbed: (slug: string) =>
      request<{ accepted: true; slug: string }>(
        `/api/instances/${encodeURIComponent(slug)}/memories/re-embed`,
        { method: "POST" },
      ),
```

- [ ] **Step 3: i18n** — in both `en.json` and `it.json`, add keys `memory.banner.openaiNeedsKey`, `memory.banner.bedrockNeedsAws`, `memory.banner.anthropicNeedsOpenAI`, `memory.migrate.title`, `memory.migrate.body` (with `{provider}` + `{count}` placeholders), `memory.migrate.primary`. EN/IT copy:

```jsonc
// en.json
"memory.banner.openaiNeedsKey": "Memory requires an OpenAI API key. Configure it in Settings → AI Provider.",
"memory.banner.bedrockNeedsAws": "Memory with Bedrock requires AWS credentials. Configure them in Settings → AI Provider.",
"memory.banner.anthropicNeedsOpenAI": "Memory with Anthropic requires an OpenAI API key for embeddings.",
"memory.migrate.title": "Provider change: re-embedding required",
"memory.migrate.body": "Switching to {provider} requires re-embedding {count} memories. This will use your target provider's API quota.",
"memory.migrate.primary": "Start re-embed",
```
```jsonc
// it.json
"memory.banner.openaiNeedsKey": "La memoria richiede una chiave API OpenAI. Configurala in Settings → AI Provider.",
"memory.banner.bedrockNeedsAws": "La memoria con Bedrock richiede credenziali AWS. Configurale in Settings → AI Provider.",
"memory.banner.anthropicNeedsOpenAI": "La memoria con Anthropic richiede una chiave API OpenAI per gli embeddings.",
"memory.migrate.title": "Cambio provider: re-embedding richiesto",
"memory.migrate.body": "Cambiando provider a {provider} è necessario ri-generare gli embeddings per {count} memorie. L'operazione userà la quota API del provider di destinazione.",
"memory.migrate.primary": "Avvia re-embed",
```

- [ ] **Step 4: `settings-tab.tsx`** — ensure `AlertDialog*` components and the `BRAND_NAMES` map are imported (they already exist in this file for the pricing dialog / provider labels — verify and reuse). Add state `migrateOpen`/`migrateCount`. Split the existing `handleSave` into `performSave(triggerReEmbed)` (does the save, then optionally `api.memories.reEmbed(instance.slug)`) and a new `handleSave` that, when the provider changed AND memory is enabled AND `api.memories.list({instanceId: instance.id, limit: 1}).total > 0`, opens the migration dialog instead of saving directly. Add `handleMigrateConfirm` (closes dialog, `performSave(true)`) and `handleMigrateCancel` (closes dialog, reverts `provider`/`model` to the instance values). Replace the static banner condition with `memoryEnabled && instance.memory?.needsOpenAIKey` and pick the message by `provider` (`bedrock` → `memory.banner.bedrockNeedsAws`, `anthropic` → `memory.banner.anthropicNeedsOpenAI`, else `memory.banner.openaiNeedsKey`). Render the `AlertDialog` (title/body/primary/cancel from the new i18n keys, body interpolating `BRAND_NAMES[provider] ?? provider` and `migrateCount`).

- [ ] **Step 5: Typecheck + lint + test web**
```bash
npm run typecheck -w @polyant/web
npm run lint -w @polyant/web
npm test -w @polyant/web
```
Expected: clean.

- [ ] **Step 6: Commit**
```bash
git add packages/web/src
git commit -s -m "feat(web): provider-aware memory banner + re-embed migration prompt"
```

---

## Task 12: Docs + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the embeddings caveat in `CLAUDE.md`** — replace the *"Embeddings always use OpenAI…"* bullet under **Important Caveats** with:

> **Embeddings are per-instance, provider-aware.** Each instance has `embedding_dim` (1024 or 1536). OpenAI-provider instances can use either dim; Bedrock-provider instances are always 1024 (Titan v2). Anthropic-provider instances fall back to OpenAI for embeddings and must configure `openai_api_key`. The `embeddings-gateway` module picks the right model + credentials based on the instance. The `memories` and `knowledge_chunks` tables have two parallel vector columns (`embedding vector(1536)`, `embedding_1024 vector(1024)`) with an XOR check constraint — exactly one is populated per row, decided by the owning instance's `embedding_dim`. Switching provider on an existing instance triggers a re-embed job.

- [ ] **Step 2: Full verification (engine + web)**
```bash
npm run typecheck
npm run lint
npm run test:unit -w @polyant/engine
npm test -w @polyant/web
```
Expected: all clean / green. (Integration/functional engine tests require Postgres + live provider keys; run `npm run test:integration -w @polyant/engine` if a DB is available.)

- [ ] **Step 3: Manual smoke (optional, needs DB + a Bedrock instance)** — create a fresh instance with `provider: "bedrock"` and `aws_region` set, no OpenAI key; enable memory; `POST /memories` ⇒ 201 with a row in `embedding_1024` (`embedding_provider = "bedrock"`); confirm the XOR constraint holds and search returns the memory.

- [ ] **Step 4: Commit**
```bash
git add CLAUDE.md
git commit -s -m "docs(claude): replace OpenAI-only embeddings caveat with provider-aware model"
```

---

## Self-Review Notes

- **Spec coverage:** Tasks 1–4 (gateway), 5 (schema/migration), 6–7 (column-aware stores), 8 (call-site refactor + embedder deletion), 9 (re-embed), 10 (memory-status + DTO), 11 (web banner + prompt), 12 (CLAUDE.md) — maps to every acceptance criterion in the issue.
- **Backward compat:** legacy instances default to `embedding_dim = 1536` (DB default); new instances get 1024 at the app layer; no forced re-embed. The XOR constraint + dim-routing guarantee no cross-dimension vector comparison within an instance.
- **Out of scope (follow-up issues):** dropping the legacy 1536 column + XOR constraint after all instances migrate; a dedicated re-embed progress UI; knowledge-base re-embed UI (the same service pattern applies but is not wired to a button this iteration).
- **Convention exception:** `provider-resolver.ts` reads `process.env.AWS_REGION` directly, mirroring `ai-gateway/providers/bedrock.ts`; tag it `// CONVENTION-EXCEPTION:`.
