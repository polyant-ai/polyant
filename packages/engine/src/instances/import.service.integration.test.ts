// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Importing an agent against a real Postgres: where a new agent lands and what
 * its row holds, which bundles are refused before anything is written, and what
 * an overwrite replaces on the target — and on nothing else. Self-skips when no
 * migrated database is reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The tool recompute after commit, wrapped so one test can make it fail. It
  delegates to the real implementation unless a test arms it.
*/
let failTheRecompute = false;
vi.mock("./instance-tools.store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./instance-tools.store.js")>();
  return {
    ...actual,
    recomputeInstanceTools: async (...args: Parameters<typeof actual.recomputeInstanceTools>) => {
      if (failTheRecompute) throw new Error("recompute failed");
      return actual.recomputeInstanceTools(...args);
    },
  };
});

import { lockToolsTable, resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { registerEmbeddingProvider } from "../embeddings-gateway/registry.js";
import { createInstanceWithDefaults } from "./store.js";
import { resolveInstanceConfig } from "./config-resolver.js";
import { asInstanceSlug } from "./identifiers.js";
import { ImportSlugTakenError, importNewInstance, importOverwriteInstance } from "./import.service.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-import-svc";

let orgId: string;
let wsId: string;
let otherOrgWsId: string;
let otherOrgId: string;
let imports = 0;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM scheduled_tasks WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM tools WHERE name LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

async function createOrg(slug: string): Promise<{ orgId: string; wsId: string }> {
  const [org] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${slug}, 'import org', false) RETURNING id`;
  const [ws] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${org.id}, ${slug}, 'import ws', false) RETURNING id`;
  return { orgId: org.id, wsId: ws.id };
}

const freshSlug = () => `${MARKER}-new-${++imports}`;

function makeBundle(slug: string, instance: Record<string, unknown> = {}, version = "1.3") {
  return {
    version,
    exportedAt: "2026-07-28T00:00:00.000Z",
    type: "instance" as const,
    instance: {
      slug,
      name: "Imported Agent",
      description: null,
      status: "active",
      provider: "openai",
      model: "gpt-4o",
      memoryEnabled: false,
      knowledgeEnabled: false,
      langsmithEnabled: false,
      authEnabled: false,
      prompts: [],
      skills: [],
      manualTools: [],
      secrets: [],
      channels: [],
      skillEnv: [],
      room: null,
      eventSources: [],
      ...instance,
    },
  };
}

async function agentRow(slug: string) {
  const [row] = await queryClient<
    { id: string; name: string; workspace_id: string; memory_enabled: boolean; stt_provider: string; embedding_provider: string; embedding_dim: number; model: string }[]
  >`
    SELECT id, name, workspace_id, memory_enabled, stt_provider, embedding_provider, embedding_dim, model
    FROM instances WHERE slug = ${slug}`;
  return row;
}

async function webChannel(slug: string): Promise<boolean | undefined> {
  const [row] = await queryClient<{ enabled: boolean }[]>`
    SELECT c.enabled FROM instance_channels c JOIN instances i ON i.id = c.instance_id
    WHERE i.slug = ${slug} AND c.channel_type = 'web'`;
  return row?.enabled;
}

describe.skipIf(!DB_AVAILABLE)("importing an agent (integration)", () => {
  // Agents are created with their default tools: keep a prune of the catalog
  // (`database/test-db.ts`) from running while they are.
  let releaseToolsLock: () => Promise<void> = async () => {};

  beforeAll(async () => {
    releaseToolsLock = await lockToolsTable("shared");
    await teardown();
    ({ orgId, wsId } = await createOrg(MARKER));
    ({ orgId: otherOrgId, wsId: otherOrgWsId } = await createOrg(`${MARKER}-other`));
  });

  beforeEach(() => {
    failTheRecompute = false;
  });

  afterAll(async () => {
    await teardown();
    await releaseToolsLock();
  });

  describe("as a new agent", () => {
    it("creates it in the caller organization's workspace, under the confirmed slug and trimmed name", async () => {
      const slug = freshSlug();
      const result = await importNewInstance(makeBundle(slug, { name: "  Chosen name  " }), otherOrgId);

      expect(result.slug).toBe(slug);
      expect(await agentRow(slug)).toMatchObject({ id: result.instanceId, name: "Chosen name", workspace_id: otherOrgWsId });
      expect(otherOrgWsId).not.toBe(wsId);
    });

    it("refuses when the caller's organization cannot be resolved, writing no agent anywhere", async () => {
      // More than one organization exists (this file adds two), so none is implied.
      const slug = freshSlug();

      await expect(importNewInstance(makeBundle(slug), undefined)).rejects.toThrow(/Cannot resolve the caller's organization/);
      expect(await agentRow(slug)).toBeUndefined();
    });

    it("keeps the capability values the bundle states", async () => {
      const slug = freshSlug();
      await importNewInstance(makeBundle(slug, { memoryEnabled: true, sttProvider: "deepgram" }), orgId);

      expect(await agentRow(slug)).toMatchObject({ memory_enabled: true, stt_provider: "deepgram" });
    });

    it("refuses a slug another agent already uses, without renaming it or writing a second agent", async () => {
      const slug = freshSlug();
      await importNewInstance(makeBundle(slug), orgId);

      const attempt = importNewInstance(makeBundle(slug, { name: "Second" }), orgId);

      await expect(attempt).rejects.toBeInstanceOf(ImportSlugTakenError);
      await expect(attempt).rejects.toThrow(`Slug "${slug}" already exists`);
      const [{ n }] = await queryClient<{ n: number }[]>`SELECT count(*)::int AS n FROM instances WHERE slug = ${slug}`;
      expect(n).toBe(1);
      expect((await agentRow(slug))!.name).toBe("Imported Agent");
    });

    it("passes through an insert failure that is not a taken slug, and writes nothing", async () => {
      const slug = freshSlug();
      // A value longer than the column holds: the row is refused, and not for its slug.
      const attempt = importNewInstance(makeBundle(slug, { status: "s".repeat(21) }), orgId);

      await expect(attempt).rejects.not.toBeInstanceOf(ImportSlugTakenError);
      await expect(attempt).rejects.toThrow();
      expect(await agentRow(slug)).toBeUndefined();
    });

    it("refuses an embedder this deployment does not serve, writing nothing", async () => {
      const slug = freshSlug();

      await expect(
        importNewInstance(makeBundle(slug, { embeddingProvider: "an-embedder-nobody-serves" }), orgId),
      ).rejects.toThrow(/Embedding provider "an-embedder-nobody-serves" is not available in this deployment/);
      expect(await agentRow(slug)).toBeUndefined();
    });

    it("stores a registered embedder as named, and openai when the bundle names none", async () => {
      registerEmbeddingProvider({
        name: "import-itest-emb",
        label: "Import Test Embedder",
        baseURL: "https://example.invalid/v1",
        modelId: "an-embedding-model",
        apiKeySecret: "import_itest_embedder_api_key",
        supportedDims: [1024],
      });
      const named = freshSlug();
      const unnamed = freshSlug();

      await importNewInstance(makeBundle(named, { embeddingProvider: "import-itest-emb", embeddingDim: 1024 }), orgId);
      await importNewInstance(makeBundle(unnamed), orgId);

      expect((await agentRow(named))!.embedding_provider).toBe("import-itest-emb");
      expect((await agentRow(unnamed))!.embedding_provider).toBe("openai");
    });

    it("reads a 1.3 bundle without a web row as Web off, and a 1.2 bundle as Web on", async () => {
      const current = freshSlug();
      const legacy = freshSlug();

      await importNewInstance(makeBundle(current), orgId);
      await importNewInstance(makeBundle(legacy, {}, "1.2"), orgId);

      expect(await webChannel(current)).toBeUndefined();
      expect(await webChannel(legacy)).toBe(true);
    });
  });

  describe("over an existing agent", () => {
    let toolId: string;

    async function createAgent(suffix: string) {
      return createInstanceWithDefaults({ slug: asInstanceSlug(`${MARKER}-${suffix}`), name: suffix, orgId, workspaceSlug: MARKER });
    }

    /** Give an agent one row of every kind an overwrite replaces. */
    async function furnish(agent: { id: string; slug: string }) {
      await queryClient`INSERT INTO instance_tools (instance_id, tool_id, source) VALUES (${agent.id}, ${toolId}, 'manual')`;
      await queryClient`INSERT INTO instance_channels (instance_id, channel_type, enabled, config) VALUES (${agent.id}, 'web', true, '')`;
      await queryClient`INSERT INTO instance_room (instance_id, enabled, prompt) VALUES (${agent.id}, true, 'room prompt')`;
      await queryClient`
        INSERT INTO scheduled_tasks (instance_id, name, schedule, prompt)
        VALUES (${agent.slug}, 'old task', ${JSON.stringify({ type: "cron", expression: "0 9 * * *" })}::jsonb, 'p')`;
    }

    async function holdings(agent: { id: string; slug: string }) {
      const count = async (rows: Promise<{ n: number }[]>) => (await rows)[0]!.n;
      return {
        manualTools: await count(queryClient`SELECT count(*)::int AS n FROM instance_tools WHERE instance_id = ${agent.id} AND source = 'manual'`),
        channels: await count(queryClient`SELECT count(*)::int AS n FROM instance_channels WHERE instance_id = ${agent.id}`),
        room: await count(queryClient`SELECT count(*)::int AS n FROM instance_room WHERE instance_id = ${agent.id}`),
        tasks: (await queryClient<{ name: string }[]>`SELECT name FROM scheduled_tasks WHERE instance_id = ${agent.slug}`).map((r) => r.name),
      };
    }

    beforeAll(async () => {
      const [row] = await queryClient<{ id: string }[]>`
        INSERT INTO tools (name, description) VALUES (${`${MARKER}-tool`}, 'test tool') RETURNING id`;
      toolId = row.id;
    });

    it("replaces the target's tools, channels, room and scheduled tasks, filing tasks under its slug, and leaves other agents alone", async () => {
      const target = await createAgent("ow-target");
      const bystander = await createAgent("ow-bystander");
      await furnish(target);
      await furnish(bystander);

      await importOverwriteInstance(
        target.slug,
        makeBundle("irrelevant-in-a-bundle", {
          channels: [{ channelType: "web", enabled: false, config: {} }],
          scheduledTasks: [{
            name: "new task", description: null, enabled: true,
            schedule: { type: "cron", expression: "0 10 * * *" }, prompt: "p",
            outboundChannel: null, outboundTarget: null, keepHistory: true, deleteAfterRun: false,
            maxRetries: 0, maxRunMs: null, createdBy: null,
          }],
        }),
      );

      expect(await holdings(target)).toEqual({ manualTools: 0, channels: 1, room: 0, tasks: ["new task"] });
      expect(await webChannel(target.slug)).toBe(false);
      expect(await holdings(bystander)).toEqual({ manualTools: 1, channels: 1, room: 1, tasks: ["old task"] });
    });

    it("removes the target's scheduled tasks when the bundle carries none", async () => {
      const target = await createAgent("ow-no-tasks");
      await furnish(target);

      await importOverwriteInstance(target.slug, makeBundle("x"));

      expect((await holdings(target)).tasks).toEqual([]);
    });

    it("keeps the stated capabilities and leaves the embedder columns as they were", async () => {
      const target = await createAgent("ow-capabilities");
      const before = await agentRow(target.slug);

      await importOverwriteInstance(
        target.slug,
        makeBundle("x", { memoryEnabled: true, sttProvider: "deepgram", embeddingProvider: "voyage", embeddingDim: 9999 }),
      );

      expect(await agentRow(target.slug)).toMatchObject({
        memory_enabled: true,
        stt_provider: "deepgram",
        embedding_provider: before!.embedding_provider,
        embedding_dim: before!.embedding_dim,
      });
    });

    it("warns once for each encrypted skill variable and not for plain ones", async () => {
      const target = await createAgent("ow-skill-env");

      const result = await importOverwriteInstance(
        target.slug,
        makeBundle("x", {
          skillEnv: [
            { skillSlug: "s1", key: "PLAIN", value: "v", encrypted: false },
            { skillSlug: "s1", key: "SECRET", encrypted: true },
          ],
        }),
      );

      const envWarnings = result.warnings.filter((w) => w.type === "skill_env_required");
      expect(envWarnings).toHaveLength(1);
      expect(envWarnings[0]!.message).toContain("s1.SECRET");
    });

    it("serves the imported configuration at once, not the one cached before", async () => {
      const target = await createAgent("ow-cache");
      expect((await resolveInstanceConfig(target.slug)).model).not.toBe("gpt-4.1-mini");

      await importOverwriteInstance(target.slug, makeBundle("x", { model: "gpt-4.1-mini" }));

      expect((await resolveInstanceConfig(target.slug)).model).toBe("gpt-4.1-mini");
    });

    it("keeps a committed import, refreshes the cached configuration and warns when the tool recompute fails", async () => {
      const target = await createAgent("ow-recompute");
      await resolveInstanceConfig(target.slug);
      failTheRecompute = true;

      const result = await importOverwriteInstance(target.slug, makeBundle("x", { model: "gpt-4.1-nano" }));

      expect(result.warnings.map((w) => w.type)).toContain("tool_recompute_failed");
      expect((await agentRow(target.slug))!.model).toBe("gpt-4.1-nano");
      expect((await resolveInstanceConfig(target.slug)).model).toBe("gpt-4.1-nano");
    });

    it("refuses a target that does not exist", async () => {
      await expect(importOverwriteInstance(`${MARKER}-missing`, makeBundle("x"))).rejects.toThrow(/not found/);
      expect(await agentRow(`${MARKER}-missing`)).toBeUndefined();
    });
  });
});
