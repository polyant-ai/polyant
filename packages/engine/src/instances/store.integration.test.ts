// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent store against a real Postgres: which workspace a new agent lands in,
 * which agents each listing returns, and what an update writes. The tenant
 * predicates are SQL, so only a database can tell a scoped read from one that
 * reaches across organizations. Creating with defaults is covered by
 * `create-instance.integration.test.ts`, the organization's agent order by
 * `list-instances.integration.test.ts`.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockToolsTable, resolveDatabaseAvailability } from "../database/test-db.js";
import { NO_TRANSACTION, queryClient } from "../database/client.js";
import { orgScope } from "../authz/scope-filter.js";
import { DEFAULT_EMBEDDING_DIM } from "../embeddings-gateway/config.js";
import { asInstanceSlug, type InstanceSlug } from "./identifiers.js";
import {
  createInstance,
  ensureInstance,
  findInstanceBySlug,
  listActiveInstances,
  listAllInstances,
  resolveWorkspaceIdForPrincipal,
  updateInstance,
} from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = `itest-inst-store-${Date.now()}`;
const KNOWLEDGE_TOOLS = ["searchKnowledge", "getKnowledge"];

let orgA = "";
let orgB = "";
let orgWithoutWorkspace = "";
let wsDefaultA = "";
let wsSandboxA = "";
let wsB = "";

const slug = (name: string): InstanceSlug => asInstanceSlug(`${MARKER}-${name}`);

async function insertOrg(label: string): Promise<string> {
  const [{ id }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${`${MARKER}-${label}`}, ${label}, false) RETURNING id`;
  return id;
}

async function insertWorkspace(orgId: string, label: string, isDefault: boolean): Promise<string> {
  const [{ id }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default)
    VALUES (${orgId}, ${`${MARKER}-${label}`}, ${label}, ${isDefault}) RETURNING id`;
  // created_at is the transaction time: keep the insertion order observable.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return id;
}

async function insertAgent(name: string, workspaceId: string, status = "active"): Promise<void> {
  await queryClient`INSERT INTO instances (slug, name, workspace_id, status) VALUES (${slug(name)}, ${name}, ${workspaceId}, ${status})`;
}

async function enabledToolNames(agent: InstanceSlug): Promise<string[]> {
  const rows = await queryClient<{ name: string }[]>`
    SELECT t.name FROM instance_tools it
    JOIN tools t ON t.id = it.tool_id
    JOIN instances i ON i.id = it.instance_id
    WHERE i.slug = ${agent} ORDER BY t.name`;
  return rows.map((r) => r.name);
}

describe.skipIf(!DB_AVAILABLE)("agent store (integration)", () => {
  // The knowledge test needs the knowledge tools in the catalog; serialized with
  // any suite that prunes tool rows (`database/test-db.ts`).
  let releaseToolsLock: () => Promise<void> = async () => {};

  beforeAll(async () => {
    releaseToolsLock = await lockToolsTable("shared");
    for (const name of KNOWLEDGE_TOOLS) {
      await queryClient`INSERT INTO tools (name, description) VALUES (${name}, ${MARKER}) ON CONFLICT (name) DO NOTHING`;
    }
    orgA = await insertOrg("a");
    orgB = await insertOrg("b");
    orgWithoutWorkspace = await insertOrg("empty");
    // The deployment holds one default workspace, the seed organization's: these
    // organizations fall back to their oldest workspace.
    wsDefaultA = await insertWorkspace(orgA, "main", false);
    wsSandboxA = await insertWorkspace(orgA, "sandbox", false);
    wsB = await insertWorkspace(orgB, "b-main", false);
    await insertAgent("a-active", wsDefaultA);
    await insertAgent("a-paused", wsDefaultA, "paused");
    await insertAgent("a-sandboxed", wsSandboxA);
    await insertAgent("b-active", wsB);
  });

  afterAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
    await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
    await releaseToolsLock();
  });

  describe("the workspace a new agent lands in", () => {
    it("is the caller organization's oldest workspace when it has no default one", async () => {
      expect(await resolveWorkspaceIdForPrincipal(orgA, NO_TRANSACTION)).toBe(wsDefaultA);
    });

    it("is the addressed workspace when the caller's organization owns it", async () => {
      expect(await resolveWorkspaceIdForPrincipal(orgA, NO_TRANSACTION, `${MARKER}-sandbox`)).toBe(wsSandboxA);
    });

    it("is refused when the addressed workspace belongs to another organization", async () => {
      await expect(resolveWorkspaceIdForPrincipal(orgA, NO_TRANSACTION, `${MARKER}-b-main`)).rejects.toThrow(
        /does not belong to the caller/i,
      );
    });

    it("is refused when the caller's organization owns no workspace", async () => {
      await expect(resolveWorkspaceIdForPrincipal(orgWithoutWorkspace, NO_TRANSACTION)).rejects.toThrow(/no workspace/i);
    });

    it("is refused when the caller names no organization and the deployment has several", async () => {
      await expect(resolveWorkspaceIdForPrincipal(undefined, NO_TRANSACTION)).rejects.toThrow(/organization/i);
    });
  });

  describe("createInstance", () => {
    it("creates the agent in the caller's workspace, with its key required and unset fields empty", async () => {
      const agent = await createInstance({ slug: slug("created"), name: "Created", orgId: orgB }, NO_TRANSACTION);

      expect(agent).toMatchObject({
        slug: slug("created"),
        name: "Created",
        description: null,
        provider: null,
        model: null,
        authEnabled: true,
        embeddingDim: DEFAULT_EMBEDDING_DIM,
        embeddingProvider: "openai",
        workspaceId: wsB,
      });
    });

    it("keeps the description, provider and model it is given", async () => {
      const agent = await createInstance(
        { slug: slug("described"), name: "Described", description: "about", provider: "openai", model: "gpt-4o", orgId: orgA },
        NO_TRANSACTION,
      );

      expect(agent).toMatchObject({ description: "about", provider: "openai", model: "gpt-4o", workspaceId: wsDefaultA });
    });
  });

  describe("ensureInstance", () => {
    it("creates a missing agent once and leaves an existing one as it is", async () => {
      await ensureInstance({ slug: slug("seeded"), name: "Seeded" });
      await ensureInstance({ slug: slug("seeded"), name: "Renamed", description: "ignored" });

      expect(await findInstanceBySlug(slug("seeded"))).toMatchObject({ name: "Seeded", description: null });
    });
  });

  describe("reads", () => {
    it("finds an agent by slug, and nothing for an unknown one", async () => {
      expect((await findInstanceBySlug(slug("a-active")))?.name).toBe("a-active");
      expect(await findInstanceBySlug(slug("missing"))).toBeUndefined();
    });

    it("lists the active agents of the scoped organization only", async () => {
      const names = (await listActiveInstances(orgScope(orgA))).map((a) => a.slug).filter((s) => s.startsWith(MARKER));

      expect(names.sort()).toEqual([slug("a-active"), slug("a-sandboxed"), slug("described")].sort());
    });

    it("narrows an organization's listing to the addressed workspace", async () => {
      const names = (await listAllInstances(orgA, `${MARKER}-sandbox`)).map((a) => a.slug);

      expect(names).toEqual([slug("a-sandboxed")]);
    });

    it("lists nothing for a workspace slug of another organization", async () => {
      expect(await listAllInstances(orgA, `${MARKER}-b-main`)).toEqual([]);
    });

    it("lists every organization's agents for a system caller", async () => {
      const names = new Set((await listAllInstances()).map((a) => a.slug));

      expect(names.has(slug("a-active"))).toBe(true);
      expect(names.has(slug("b-active"))).toBe(true);
    });
  });

  describe("updateInstance", () => {
    it("writes the patch and returns the updated agent", async () => {
      const updated = await updateInstance(slug("a-active"), {
        name: "Renamed",
        datetimeTimezone: "Europe/Rome",
        datetimeLocale: "it-IT",
        dedupSimilarityThreshold: 0.85,
        messageSoftDebounceMs: 0,
        messageTypingDelayMs: 1500,
      });

      expect(updated).toMatchObject({
        name: "Renamed",
        datetimeTimezone: "Europe/Rome",
        datetimeLocale: "it-IT",
        dedupSimilarityThreshold: 0.85,
        messageSoftDebounceMs: 0,
        messageTypingDelayMs: 1500,
      });
      expect((await findInstanceBySlug(slug("a-active")))?.name).toBe("Renamed");
    });

    it("clears a setting set to null", async () => {
      await updateInstance(slug("a-active"), { messageMaxRestarts: 3 });

      await updateInstance(slug("a-active"), { messageMaxRestarts: null });

      expect((await findInstanceBySlug(slug("a-active")))?.messageMaxRestarts).toBeNull();
    });

    it("ignores a key that is not an updatable setting", async () => {
      const before = await findInstanceBySlug(slug("a-active"));

      // A JSON body can carry anything; NestJS does not strip it.
      await updateInstance(slug("a-active"), { name: "Kept", embeddingDim: 9999 } as never);

      const after = await findInstanceBySlug(slug("a-active"));
      expect(after?.name).toBe("Kept");
      expect(after?.embeddingDim).toBe(before?.embeddingDim);
    });

    it("returns nothing for an unknown agent, whether or not it turns Knowledge on", async () => {
      expect(await updateInstance(slug("missing"), { name: "No match" })).toBeUndefined();
      expect(await updateInstance(slug("missing"), { knowledgeEnabled: true })).toBeUndefined();
    });

    it("assigns the knowledge tools when Knowledge goes from off to on, and only then", async () => {
      const agent = slug("a-sandboxed");
      await updateInstance(agent, { knowledgeEnabled: false });

      await updateInstance(agent, { knowledgeEnabled: true });
      expect(await enabledToolNames(agent)).toEqual([...KNOWLEDGE_TOOLS].sort());

      // The author removes one; saving with Knowledge still on must not bring it back.
      await queryClient`
        DELETE FROM instance_tools WHERE tool_id = (SELECT id FROM tools WHERE name = 'getKnowledge')
          AND instance_id = (SELECT id FROM instances WHERE slug = ${agent})`;
      await updateInstance(agent, { knowledgeEnabled: true });
      expect(await enabledToolNames(agent)).toEqual(["searchKnowledge"]);

      // Turning it off removes nothing.
      await updateInstance(agent, { knowledgeEnabled: false });
      expect(await enabledToolNames(agent)).toEqual(["searchKnowledge"]);
    });
  });
});
