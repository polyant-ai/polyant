// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const findInstanceBySlug = vi.fn();
vi.mock("./store.js", () => ({ findInstanceBySlug: (...args: unknown[]) => findInstanceBySlug(...args) }));

import {
  invalidateAllInstanceMeta,
  invalidateInstanceMeta,
  resolveInstanceMeta,
  resolveInstanceUuid,
} from "./instance-meta.js";

function row(slug: string, name: string) {
  return { id: `uuid-${slug}`, slug, name, icon: null, updatedAt: new Date("2026-10-01T00:00:00Z") };
}

describe("instance meta cache", () => {
  beforeEach(() => {
    invalidateAllInstanceMeta();
    findInstanceBySlug.mockReset();
  });

  it("should_read_the_row_once_for_repeated_lookups", async () => {
    findInstanceBySlug.mockResolvedValue(row("a", "Agent A"));

    const first = await resolveInstanceMeta("a");
    const uuid = await resolveInstanceUuid("a");
    const again = await resolveInstanceMeta("a");

    expect(first).toEqual({ id: "uuid-a", slug: "a", name: "Agent A", icon: null });
    expect(uuid).toBe("uuid-a");
    expect(again).toEqual(first);
    expect(findInstanceBySlug).toHaveBeenCalledTimes(1);
  });

  it("should_show_a_rename_as_soon_as_the_entry_is_invalidated", async () => {
    findInstanceBySlug.mockResolvedValueOnce(row("a", "Old name")).mockResolvedValueOnce(row("a", "New name"));

    expect((await resolveInstanceMeta("a"))?.name).toBe("Old name");
    invalidateInstanceMeta("a");

    expect((await resolveInstanceMeta("a"))?.name).toBe("New name");
    expect(findInstanceBySlug).toHaveBeenCalledTimes(2);
  });

  it("should_report_an_unknown_slug_as_absent_without_rereading_it", async () => {
    findInstanceBySlug.mockResolvedValue(undefined);

    expect(await resolveInstanceUuid("ghost")).toBeUndefined();
    expect(await resolveInstanceMeta("ghost")).toBeUndefined();
    expect(findInstanceBySlug).toHaveBeenCalledTimes(1);
  });

  it("should_not_cache_a_failed_read", async () => {
    findInstanceBySlug.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(row("a", "Agent A"));

    expect(await resolveInstanceMeta("a")).toBeUndefined();
    expect((await resolveInstanceMeta("a"))?.name).toBe("Agent A");
  });
});
