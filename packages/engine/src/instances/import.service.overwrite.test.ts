// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Orchestration tests for importOverwriteInstance — the destructive path.
 *
 * Every domain gets a delete-then-reimport pair, in a fixed order, run
 * inside one transaction. The per-domain import logic itself is already
 * covered against a fake `tx` in the sibling `{entity}.import.test.ts`
 * files, so every `{entity}.import.js` module is mocked out here: this
 * suite exists only to pin the ORCHESTRATOR's contract — call order,
 * delete predicates, the slug-vs-uuid trap on scheduled tasks, the
 * conditional room import, the untouched embedder columns, and the
 * post-transaction cache-invalidation order.
 */

const {
  mockEq,
  mockAnd,
  mockDb,
  mockRecomputeInstanceTools,
  mockInvalidatePromptsCache,
  mockInvalidateInstanceConfigCache,
  mockInvalidateHooksCache,
  mockImportPrompts,
  mockImportSkillAssignments,
  mockImportManualTools,
  mockImportChannels,
  mockImportSkillEnvOverwrite,
  mockImportHooks,
  mockImportRoom,
  mockImportEventSources,
  mockImportScheduledTasks,
  mockImportMcpServers,
} = vi.hoisted(() => ({
  // Real `eq`/`and` behaviour is preserved (see the `drizzle-orm` mock below,
  // which delegates to the actual implementation) — only wrapped so the
  // predicates the orchestrator builds can be asserted on directly, instead
  // of walking the SQL AST (which is circular: a column points back at its
  // table, which references every sibling column — including a
  // `.default("manual")` on an unrelated column — making naive tree-walking
  // assertions pass even when the real predicate was widened).
  mockEq: vi.fn(),
  mockAnd: vi.fn(),
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  mockRecomputeInstanceTools: vi.fn(),
  mockInvalidatePromptsCache: vi.fn(),
  mockInvalidateInstanceConfigCache: vi.fn(),
  mockInvalidateHooksCache: vi.fn(),
  mockImportPrompts: vi.fn(async () => undefined),
  mockImportSkillAssignments: vi.fn(async () => []),
  mockImportManualTools: vi.fn(async () => []),
  mockImportChannels: vi.fn(async () => []),
  mockImportSkillEnvOverwrite: vi.fn(async () => undefined),
  mockImportHooks: vi.fn(async () => undefined),
  mockImportRoom: vi.fn(async () => undefined),
  mockImportEventSources: vi.fn(async () => []),
  mockImportScheduledTasks: vi.fn(async () => undefined),
  mockImportMcpServers: vi.fn(async () => []),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  mockEq.mockImplementation(actual.eq);
  mockAnd.mockImplementation(actual.and);
  return { ...actual, eq: mockEq, and: mockAnd };
});
vi.mock("../database/client.js", () => ({ db: mockDb }));
vi.mock("./instance-tools.store.js", () => ({ recomputeInstanceTools: mockRecomputeInstanceTools }));
vi.mock("./prompts.store.js", () => ({ invalidatePromptsCache: mockInvalidatePromptsCache }));
vi.mock("./config-resolver.js", () => ({
  invalidateInstanceConfigCache: mockInvalidateInstanceConfigCache,
}));
vi.mock("../hooks/hooks.store.js", () => ({ invalidateHooksCache: mockInvalidateHooksCache }));
vi.mock("./prompts.import.js", () => ({ importPrompts: mockImportPrompts }));
vi.mock("./skill-assignments.import.js", () => ({ importSkillAssignments: mockImportSkillAssignments }));
vi.mock("./manual-tools.import.js", () => ({ importManualTools: mockImportManualTools }));
vi.mock("./channels.import.js", () => ({ importChannels: mockImportChannels }));
vi.mock("./skill-env.import.js", () => ({
  importSkillEnv: vi.fn(async () => []),
  importSkillEnvOverwrite: mockImportSkillEnvOverwrite,
}));
vi.mock("./hooks.import.js", () => ({ importHooks: mockImportHooks }));
vi.mock("./room.import.js", () => ({ importRoom: mockImportRoom }));
vi.mock("./event-sources.import.js", () => ({ importEventSources: mockImportEventSources }));
vi.mock("./scheduled-tasks.import.js", () => ({ importScheduledTasks: mockImportScheduledTasks }));
vi.mock("./mcp-servers.import.js", () => ({ importMcpServers: mockImportMcpServers }));

import { importOverwriteInstance } from "./import.service.js";
import { instanceSkills } from "./instance-skills.schema.js";
import { instanceTools } from "./instance-tools.schema.js";
import { instanceChannels } from "./channels.schema.js";
import { instanceRoom } from "../room/room.schema.js";
import { instanceHooks } from "../hooks/hooks.schema.js";
import { eventSources } from "../webhooks/webhooks.schema.js";
import { scheduledTasks } from "../scheduled-tasks/schema.js";
import { instanceMcpServers } from "./mcp-servers.schema.js";

const TARGET_SLUG = "existing-agent";
const INSTANCE_ID = "existing-uuid";

/** Table reference → human label, used to read back `db.delete(table)` call order. */
const TABLE_LABELS = new Map<unknown, string>([
  [instanceSkills, "skills"],
  [instanceTools, "manualTools"],
  [instanceChannels, "channels"],
  [instanceHooks, "hooks"],
  [instanceRoom, "room"],
  [eventSources, "eventSources"],
  [scheduledTasks, "scheduledTasks"],
  [instanceMcpServers, "mcpServers"],
]);

function labelOfDeletedTable(table: unknown): string {
  return TABLE_LABELS.get(table) ?? `unknown(${String(table)})`;
}

/** Generic proxy chain: every unknown method returns itself; `then` resolves it. */
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) chain[prop] = vi.fn(() => self);
      return chain[prop];
    },
  });
  return self;
}

/** Minimal bundle with every optional section populated so every step fires. */
function makeBundle(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.2" as const,
    exportedAt: "2026-07-28T00:00:00.000Z",
    type: "instance" as const,
    instance: {
      slug: "irrelevant-in-a-bundle",
      name: "Overwritten Agent",
      description: null,
      status: "active",
      provider: "openai",
      model: "gpt-4o",
      memoryEnabled: false,
      knowledgeEnabled: false,
      langsmithEnabled: false,
      authEnabled: false,
      embeddingProvider: "voyage",
      embeddingDim: 9999,
      prompts: [],
      skills: [],
      manualTools: [],
      secrets: [],
      channels: [],
      skillEnv: [
        { skillSlug: "s1", key: "PLAIN", value: "v", encrypted: false },
        { skillSlug: "s1", key: "SECRET", encrypted: true },
      ],
      hooks: [],
      room: { enabled: true, prompt: "p", outboundChannel: null, outboundTarget: null, evalIntervalMinutes: 5 },
      eventSources: [],
      scheduledTasks: [{
        name: "t1",
        description: null,
        enabled: true,
        schedule: { type: "cron" },
        prompt: "p",
        outboundChannel: null,
        outboundTarget: null,
        keepHistory: true,
        deleteAfterRun: false,
        maxRetries: 0,
        createdBy: null,
      }],
      mcpServers: [],
      ...overrides,
    },
  };
}

describe("importOverwriteInstance — destructive delete-then-reimport orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
    );
    // "verify target exists" probe.
    mockDb.select.mockReturnValue(createChainMock([{ id: INSTANCE_ID }]) as never);
    mockDb.update.mockReturnValue(createChainMock() as never);
    mockDb.delete.mockImplementation(() => createChainMock() as never);
  });

  it("should_delete_before_reimporting_for_every_domain_in_the_fixed_order", async () => {
    await importOverwriteInstance(TARGET_SLUG, makeBundle());

    const deleteOrder = mockDb.delete.mock.calls.map((call) => labelOfDeletedTable(call[0]));
    expect(deleteOrder).toEqual([
      "skills",
      "manualTools",
      "channels",
      "hooks",
      "room",
      "eventSources",
      "scheduledTasks",
      "mcpServers",
    ]);

    // Each delete's global invocation index must precede its matching import's.
    const importOrderIndex: Record<string, number> = {
      skills: mockImportSkillAssignments.mock.invocationCallOrder[0],
      manualTools: mockImportManualTools.mock.invocationCallOrder[0],
      channels: mockImportChannels.mock.invocationCallOrder[0],
      hooks: mockImportHooks.mock.invocationCallOrder[0],
      room: mockImportRoom.mock.invocationCallOrder[0],
      eventSources: mockImportEventSources.mock.invocationCallOrder[0],
      scheduledTasks: mockImportScheduledTasks.mock.invocationCallOrder[0],
      mcpServers: mockImportMcpServers.mock.invocationCallOrder[0],
    };
    const deleteOrderIndex = mockDb.delete.mock.invocationCallOrder;
    for (let i = 0; i < deleteOrder.length; i++) {
      const domain = deleteOrder[i];
      expect(deleteOrderIndex[i]).toBeLessThan(importOrderIndex[domain]);
    }
  });

  it("should_scope_the_manual_tools_delete_to_source_manual_only", async () => {
    await importOverwriteInstance(TARGET_SLUG, makeBundle());

    // A widened predicate that dropped the `source` filter would never call
    // `eq(instanceTools.source, "manual")`, nor combine it with the
    // instanceId scope via `and(...)`.
    expect(mockEq).toHaveBeenCalledWith(instanceTools.source, "manual");
    expect(mockAnd).toHaveBeenCalledWith(
      mockEq(instanceTools.instanceId, INSTANCE_ID),
      mockEq(instanceTools.source, "manual"),
    );
  });

  it("should_pass_the_target_slug_not_the_instance_uuid_to_the_scheduled_tasks_delete_and_reimport", async () => {
    await importOverwriteInstance(TARGET_SLUG, makeBundle());

    expect(mockEq).toHaveBeenCalledWith(scheduledTasks.instanceId, TARGET_SLUG);
    expect(mockEq).not.toHaveBeenCalledWith(scheduledTasks.instanceId, INSTANCE_ID);

    expect(mockImportScheduledTasks).toHaveBeenCalledWith(
      mockDb,
      TARGET_SLUG,
      expect.any(Array),
    );
  });

  it("should_skip_the_room_reimport_when_the_bundle_carries_no_room_but_still_delete_the_existing_one", async () => {
    await importOverwriteInstance(TARGET_SLUG, makeBundle({ room: null }));

    expect(mockDb.delete.mock.calls.some((call) => call[0] === instanceRoom)).toBe(true);
    expect(mockImportRoom).not.toHaveBeenCalled();
  });

  it("should_skip_the_scheduled_tasks_reimport_when_the_bundle_carries_none", async () => {
    await importOverwriteInstance(TARGET_SLUG, makeBundle({ scheduledTasks: [] }));

    expect(mockDb.delete.mock.calls.some((call) => call[0] === scheduledTasks)).toBe(true);
    expect(mockImportScheduledTasks).not.toHaveBeenCalled();
  });

  it("should_invalidate_caches_in_the_fixed_order_after_the_transaction_commits", async () => {
    await importOverwriteInstance(TARGET_SLUG, makeBundle());

    expect(mockRecomputeInstanceTools.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidatePromptsCache.mock.invocationCallOrder[0],
    );
    expect(mockInvalidatePromptsCache.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidateInstanceConfigCache.mock.invocationCallOrder[0],
    );
    expect(mockInvalidateInstanceConfigCache.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidateHooksCache.mock.invocationCallOrder[0],
    );
    expect(mockRecomputeInstanceTools).toHaveBeenCalledWith(INSTANCE_ID);
    expect(mockInvalidatePromptsCache).toHaveBeenCalledWith(INSTANCE_ID);
    expect(mockInvalidateInstanceConfigCache).toHaveBeenCalledWith(TARGET_SLUG);
    expect(mockInvalidateHooksCache).toHaveBeenCalledWith(TARGET_SLUG);
  });

  it("should_never_include_the_embedder_columns_in_the_metadata_update", async () => {
    await importOverwriteInstance(TARGET_SLUG, makeBundle());

    const updateChain = mockDb.update.mock.results[0].value as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    const setArg = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty("embeddingProvider");
    expect(setArg).not.toHaveProperty("embeddingDim");
  });

  it("should_emit_exactly_one_skill_env_required_warning_per_encrypted_entry_and_none_for_plain_ones", async () => {
    const result = await importOverwriteInstance(TARGET_SLUG, makeBundle());

    const envWarnings = result.warnings.filter((w) => w.type === "skill_env_required");
    expect(envWarnings).toHaveLength(1);
    expect(envWarnings[0].message).toContain("s1.SECRET");
    expect(envWarnings[0].message).not.toContain("PLAIN");
    // The write path itself is delegated and mocked out here — this pins that
    // the orchestrator's inline warning generation does not ALSO run once per
    // write, which would double the count.
    expect(mockImportSkillEnvOverwrite).toHaveBeenCalledTimes(1);
  });

  it("should_throw_when_the_target_slug_does_not_exist_and_write_nothing", async () => {
    mockDb.select.mockReturnValue(createChainMock([]) as never);

    await expect(importOverwriteInstance("missing-agent", makeBundle())).rejects.toThrow(
      /not found/,
    );
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
