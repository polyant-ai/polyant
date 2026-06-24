# Embedder/LLM split, wipe fix, and KB export/import — Design

**Date:** 2026-06-24
**Status:** Approved (brainstorming) — pending implementation plan

## Context

A recently merged feature (from `develop-oss`) made embeddings and memory provider-aware:
each instance now carries an `embedding_dim` and the embedding provider is **derived** from
the chat AI provider via `embeddingProviderFor()` (`embeddings-gateway/config.ts`):
`bedrock → bedrock`, everything else (`openai`, `anthropic`, …) `→ openai`. Because the
embedder is coupled to the chat provider, picking a chat model that belongs to a different
provider family can silently change the embedder and trigger the destructive
"you will lose memories and knowledge base" confirmation.

Investigation surfaced **three distinct issues**, bundled into one spec at the user's
request but kept as independently implementable/testable sections:

- **A — Wipe bug (data-loss/privacy):** `resetEmbeddingsForProviderSwitch(instance.id, …)`
  (`instances.controller.ts:251`) passes the **UUID**, but `deleteAllMemories` /
  `deleteAllKnowledgeForInstance` filter **slug-text** tables (`memories.instance_id`,
  `knowledge_documents.instance_id`, `knowledge_chunks.instance_id` all store the **slug**).
  The `DELETE … WHERE instance_id = <uuid>` matches **zero rows**. The only effect is the
  `embedding_dim` realign, which masks the failure: searches embed at the new dim and hit the
  empty vector column (model "finds nothing"), while old vectors and the document list rows
  physically remain. The destructive wipe users consent to **never actually happens**. The
  unit test (`embedding-reset.service.test.ts`) fully mocks the stores and passes the same
  opaque id for both the deletes and the `instances.id` update, so the slug/UUID mismatch is
  invisible.
- **B — Embedder/LLM coupling (main request):** the embedder provider is not a stored,
  independent choice. The user wants to pick the chat LLM and the embedder provider
  separately. Embedder options are **OpenAI** and **Bedrock** only (Anthropic has no
  embeddings API — confirmed).
- **C — KB export/import:** no way to export/import the textual knowledge-base documents.
  The instance export/import only carries the `knowledgeEnabled` flag, not the documents.

**Synergy:** once C exists, it becomes the recovery path for B — export the KB raw text,
switch the embedder provider (wipe), re-import to re-embed at the new dim. Memories remain
non-recoverable (they are LLM-extracted), but the KB raw text survives.

## Decisions (locked during brainstorming)

- **B granularity:** expose **only the embedder provider** (OpenAI/Bedrock) in the admin UI.
  Embedder model and dim stay fixed in code, defaulted per provider.
- **A remediation:** **fix-forward only** — no one-shot cleanup of already-orphaned data from
  past failed wipes.
- **C format:** **JSON bundle** (single `.json`, array of `{ filename, content, … }`).
- **C duplicate handling on import:** generate a **unique filename with a progressive suffix**
  (e.g. `manuale.txt` → `manuale (1).txt`, `manuale (2).txt`), honoring the
  `(instance_id, filename)` unique constraint. No overwrite, no skip.

---

## Section A — Wipe fix

### Change

`resetEmbeddingsForProviderSwitch` takes **both** identifiers, branded so the compiler
catches future swaps:

```ts
export async function resetEmbeddingsForProviderSwitch(
  slug: InstanceSlug,            // for slug-keyed deletes (memories, knowledge)
  uuid: InstanceUuid,            // for instances.id update
  newEmbeddingProvider: EmbeddingProvider,
): Promise<EmbeddingResetResult>
```

- `deleteAllMemories(slug, tx)` and `deleteAllKnowledgeForInstance(slug, tx)` receive the
  **slug**.
- `update(instances).set({ embeddingDim }).where(eq(instances.id, uuid))` receives the
  **UUID**.
- `deleteAllMemories` / `deleteAllKnowledgeForInstance` param types tightened to
  `InstanceSlug` (they are slug-keyed) so the mismatch can never recur.

### Call site

`instances.controller.ts` PATCH handler calls
`resetEmbeddingsForProviderSwitch(before.slug, instance.id, <newEmbeddingProvider>)`.

### Tests

- New unit test passing **distinct** slug and UUID, asserting the deletes receive the **slug**
  and the `instances` update receives the **UUID**.
- An integration-style test (real stores, in-memory/test DB if available) that seeds rows
  under a slug and verifies they are actually deleted — guards against the "mock hides it"
  trap.

### Out of scope

No cleanup of data orphaned by past failed wipes (locked decision).

---

## Section B — Embedder/LLM split

### Schema

New column on `instances`:

```sql
embedding_provider varchar(20) NOT NULL DEFAULT 'openai'   -- 'openai' | 'bedrock'
```

`embedding_dim` is unchanged. Allowed embedder providers: `openai`, `bedrock` (Anthropic
excluded — no embeddings API).

### Migration (manual, incremental — repo convention)

```sql
ALTER TABLE instances ADD COLUMN embedding_provider varchar(20) NOT NULL DEFAULT 'openai';
UPDATE instances
   SET embedding_provider = CASE WHEN provider = 'bedrock' THEN 'bedrock' ELSE 'openai' END;
```

Backfill preserves existing behavior: no instance changes embedder, no wipe at migration,
existing `embedding_dim` left intact.

### Runtime resolution

- `embeddings-gateway/provider-resolver.ts` and `config.ts`: read `instance.embedding_provider`
  instead of deriving from `instance.provider`. Credentials resolved independently of the chat
  provider:
  - embedder `openai` → requires `openai_api_key` (even if chat is `bedrock`/`anthropic`)
  - embedder `bedrock` → requires AWS Bedrock credentials (even if chat is `openai`)
- `embeddingProviderFor()` is retained only for the migration backfill and as the default for
  new-instance creation; it is no longer the runtime source of truth.
- `computeMemoryStatus` reads `embedding_provider` to validate provider/dim compatibility
  (`SUPPORTED_DIMS`).
- `instances/defaults.ts` and instance creation set `embedding_provider` explicitly
  (default `openai`).

### Wipe trigger (ties A + B together)

`embeddingProviderChanged(before, after)` compares the **`embedding_provider`** field
directly (no longer the chat provider):

```ts
export function embeddingProviderChanged(
  before: { embeddingProvider: EmbeddingProvider },
  after: { embeddingProvider: EmbeddingProvider },
): boolean {
  return before.embeddingProvider !== after.embeddingProvider;
}
```

PATCH handler computes `afterEmbeddingProvider` from the body (falling back to the stored
value), and `willWipe = embeddingProviderChanged(before, after)`. The existing
`confirmWipe` + `hasData` guard is preserved. **Changing only the chat LLM provider/model no
longer triggers a wipe** — the user's primary goal.

### UI (`packages/web`)

- Settings tab: a dedicated **Embedder** select (OpenAI / Bedrock), separate from the LLM
  provider/model picker. Selecting an LLM model no longer touches the embedder.
- The destructive-confirmation dialog now fires on a change of the **embedder** select,
  comparing it against `instance.embeddingProvider` (not the chat provider).
- `lib/api.ts` instance update payload carries `embeddingProvider`.
- i18n: new labels for the embedder select; reuse existing wipe-dialog copy.

### Tests

- `embeddingProviderChanged` over the new field shape.
- PATCH handler: changing only `provider`/`model` → no wipe; changing `embeddingProvider`
  openai↔bedrock with data → 400 unless `confirmWipe`.
- Resolver: embedder resolved from `embedding_provider`, credentials picked independently of
  chat provider.

---

## Section C — KB export/import (JSON)

### Export

`GET /api/instances/:slug/knowledge/export` → JSON bundle:

```json
{
  "version": 1,
  "instanceSlug": "acme",
  "exportedAt": "2026-06-24T...Z",
  "documents": [
    { "filename": "manuale.txt", "content": "…", "source": "upload", "contentHash": "…" }
  ]
}
```

Reuses the document read path that includes `rawContent`. Returned as a downloadable file.

### Import

`POST /api/instances/:slug/knowledge/import` with the JSON bundle (validated with Zod;
reject malformed bundles with 400). For each document:

1. Resolve a unique filename: if `filename` already exists for the instance, append a
   progressive suffix before the extension — `manuale.txt` → `manuale (1).txt` →
   `manuale (2).txt` — until unique against `(instance_id, filename)`.
2. Reuse `upsertAgentDocument` + `processDocument` so the content is **re-embedded with the
   instance's current embedder** (correct dim/provider).

Pre-check (mirrors the existing upload route): verify the embedding provider is configured
before accepting the import; otherwise 400 with a clear message.

### UI (`packages/web`)

KB page: **Export** button (downloads the JSON) and **Import** button (file picker → POST).
Show progress/result counts (imported, renamed-on-collision).

### Tests

- Round-trip: export bundle → import into a fresh instance → documents present, re-embedded.
- Duplicate handling: importing a bundle whose filenames collide yields `name (1)`, `name (2)`.
- Malformed bundle → 400.
- Import invokes `processDocument` (re-embedding) per document.

---

## Files touched (summary)

**Engine**
- `instances/schema.ts` (+`embedding_provider`), `instances/defaults.ts`, new migration SQL
- `embeddings-gateway/config.ts`, `embeddings-gateway/provider-resolver.ts`,
  `embeddings-gateway/embedding-reset.service.ts` (+ tests)
- `memory/memory-store.ts`, `knowledge/store.ts` (param types → `InstanceSlug`; export reader;
  unique-filename helper)
- `server/instances/instances.controller.ts` (PATCH wipe trigger + reset call site)
- `server/instances/instance-knowledge.controller.ts` (+ export/import routes; + tests)
- `memory` status: `computeMemoryStatus`

**Web**
- `instances/[slug]/settings-tab.tsx` (embedder select + dialog trigger)
- KB page (export/import buttons), `lib/api.ts`, i18n

## Error handling

- Reset is a single transaction (existing) — slug-keyed deletes + dim realign all-or-nothing.
- Import: per-document failures collected and reported; the embedder-not-configured pre-check
  fails fast with 400.
- Provider/dim incompatibility surfaced by `computeMemoryStatus` / `assertSupportedDim`.

## Non-goals

- Converting/migrating existing vectors across embedder providers (still destructive by design).
- Cleanup of data orphaned by past failed wipes.
- Exposing embedder model or dim selection in the UI (provider-only).
- Recovering memories across an embedder switch (only KB raw text is portable, via C).
