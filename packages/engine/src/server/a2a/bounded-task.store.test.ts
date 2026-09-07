// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import type { ServerCallContext } from "@a2a-js/sdk/server";
import type { ListTasksRequest } from "@a2a-js/sdk";

import { BoundedTaskStore } from "./bounded-task.store.js";

function ctx(tenant = "t", user = "u"): ServerCallContext {
  return { tenant, user: { username: user } } as unknown as ServerCallContext;
}

function task(id: string, contextId = "c1", state = TaskState.TASK_STATE_COMPLETED): Task {
  return {
    id,
    contextId,
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: undefined,
  } as unknown as Task;
}

function listParams(over: Partial<ListTasksRequest> = {}): ListTasksRequest {
  return { tenant: "t", contextId: "", status: undefined, pageToken: "", ...over } as unknown as ListTasksRequest;
}

describe("BoundedTaskStore", () => {
  const stores: BoundedTaskStore[] = [];
  const make = (max?: number, ttl?: number) => {
    const s = new BoundedTaskStore(max, ttl, () => "owner");
    stores.push(s);
    return s;
  };
  afterEach(() => {
    while (stores.length) stores.pop()!.destroy();
  });

  it("should_round_trip_a_saved_task", async () => {
    const store = make();
    await store.save(task("a"), ctx());
    expect((await store.load("a", ctx()))?.id).toBe("a");
  });

  it("should_evict_oldest_first_when_over_max_size", async () => {
    const store = make(2);
    await store.save(task("a"), ctx());
    await store.save(task("b"), ctx());
    await store.save(task("c"), ctx());

    expect(store.size).toBe(2);
    expect(await store.load("a", ctx())).toBeUndefined(); // oldest dropped
    expect(await store.load("c", ctx())).toBeDefined();
  });

  it("should_expire_a_task_after_its_ttl", async () => {
    const store = make(100, -1); // already-expired entries
    await store.save(task("a"), ctx());
    expect(await store.load("a", ctx())).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("should_not_leak_tasks_across_tenants", async () => {
    const store = make();
    await store.save(task("a"), ctx("tenant-1"));
    expect(await store.load("a", ctx("tenant-2"))).toBeUndefined();
  });

  it("should_list_only_the_callers_tasks_filtered_by_context_id", async () => {
    const store = make();
    await store.save(task("a", "c1"), ctx("t1"));
    await store.save(task("b", "c2"), ctx("t1"));
    await store.save(task("z", "c1"), ctx("t2"));

    const res = await store.list(listParams({ contextId: "c1" }), ctx("t1"));
    expect(res.tasks.map((t: Task) => t.id)).toEqual(["a"]);
    expect(res.totalSize).toBe(1);
    expect(res.nextPageToken).toBe("");
  });

  it("should_clamp_the_page_size", async () => {
    const store = make();
    await store.save(task("a"), ctx());
    await store.save(task("b"), ctx());
    const res = await store.list(listParams({ pageSize: 1 }), ctx());
    expect(res.tasks).toHaveLength(1);
    expect(res.pageSize).toBe(1);
    expect(res.totalSize).toBe(2);
    expect((await store.list(listParams({ pageSize: 9999 }), ctx())).pageSize).toBe(100);
  });

  describe("viewFor (per-agent isolation)", () => {
    /**
     * The JSON-RPC endpoint is mounted with `UserBuilder.noAuthentication`, so
     * the SDK-shaped tenant/owner scoping collapses to one constant for every
     * caller. These tests pin the slug as the thing that actually isolates
     * agents — without it, `ListTasks` on one agent leaks every other agent's
     * tasks (message history included), across organizations.
     */
    const anon = (): ServerCallContext => ({ tenant: undefined, user: undefined }) as unknown as ServerCallContext;
    const anonStore = () => {
      const s = new BoundedTaskStore(undefined, undefined, () => "unknown");
      stores.push(s);
      return s;
    };

    it("should_not_list_another_agents_tasks_when_the_caller_is_unauthenticated", async () => {
      const store = anonStore();
      await store.viewFor("agent-a").save(task("a"), anon());
      await store.viewFor("agent-b").save(task("b"), anon());

      const res = await store.viewFor("agent-a").list(listParams({ contextId: "" }), anon());
      expect(res.tasks.map((t: Task) => t.id)).toEqual(["a"]);
      expect(res.totalSize).toBe(1);
    });

    it("should_not_load_another_agents_task_by_id", async () => {
      const store = anonStore();
      await store.viewFor("agent-a").save(task("shared-id"), anon());

      expect(await store.viewFor("agent-b").load("shared-id", anon())).toBeUndefined();
      expect(await store.viewFor("agent-a").load("shared-id", anon())).toBeDefined();
    });

    it("should_keep_the_global_cap_across_views", async () => {
      const store = new BoundedTaskStore(2, undefined, () => "unknown");
      stores.push(store);
      await store.viewFor("agent-a").save(task("a"), anon());
      await store.viewFor("agent-b").save(task("b"), anon());
      await store.viewFor("agent-c").save(task("c"), anon());
      expect(store.size).toBe(2);
    });
  });
});
