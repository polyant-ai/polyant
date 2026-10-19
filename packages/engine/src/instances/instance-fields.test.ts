// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent's writable columns are one list (`UPDATABLE_INSTANCE_KEYS`), and the
 * patch type, the bundle importer and the `PATCH` whitelist all follow it. These
 * checks fail the build's tests when the table gains a column nobody decided
 * about, or when the list and the bundle drift apart.
 */

import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { instances } from "./schema.js";
import { UPDATABLE_INSTANCE_KEYS } from "./instance-fields.js";
import { exportInstanceDataSchema, type ExportInstanceData } from "./export.schema.js";
import { instanceScalarFields } from "./import.service.js";

/** Columns of `instances` a caller may not PATCH, and why. */
const NOT_UPDATABLE: Record<string, string> = {
  id: "The row's own identity.",
  slug: "The agent's address; renaming it is a different operation.",
  workspaceId: "Tenancy; an agent does not move between workspaces through a patch.",
  embeddingDim: "Owned by the embedding-reset pipeline; set directly it desyncs from the populated vector column.",
  createdAt: "Set once by the database.",
  updatedAt: "Set by every write.",
};

describe("instance writable columns", () => {
  const columns = Object.keys(getTableColumns(instances));

  it("should_list_every_column_as_updatable_or_say_why_it_is_not", () => {
    const decided = new Set<string>([...UPDATABLE_INSTANCE_KEYS, ...Object.keys(NOT_UPDATABLE)]);
    expect(columns.filter((column) => !decided.has(column))).toEqual([]);
  });

  it("should_name_only_real_columns_and_never_both_updatable_and_not", () => {
    expect(UPDATABLE_INSTANCE_KEYS.filter((key) => !columns.includes(key))).toEqual([]);
    expect(Object.keys(NOT_UPDATABLE).filter((key) => !columns.includes(key))).toEqual([]);
    expect(UPDATABLE_INSTANCE_KEYS.filter((key) => key in NOT_UPDATABLE)).toEqual([]);
    expect(new Set(UPDATABLE_INSTANCE_KEYS).size).toBe(UPDATABLE_INSTANCE_KEYS.length);
  });

  it("should_carry_every_updatable_column_except_the_embedder_in_the_bundle_schema", () => {
    const bundleKeys = Object.keys(exportInstanceDataSchema.shape);
    expect(UPDATABLE_INSTANCE_KEYS.filter((key) => !bundleKeys.includes(key))).toEqual([]);
  });
});

describe("instanceScalarFields", () => {
  const bundle = Object.fromEntries(
    Object.keys(exportInstanceDataSchema.shape).map((key, i) => [key, `v${i}`]),
  ) as unknown as ExportInstanceData;

  it("should_write_every_updatable_column_but_the_embedder_from_the_bundle", () => {
    const fields = instanceScalarFields(bundle) as Record<string, unknown>;
    const expectedKeys = UPDATABLE_INSTANCE_KEYS.filter((key) => key !== "embeddingProvider");
    expect(Object.keys(fields).sort()).toEqual([...expectedKeys].sort());
    for (const key of expectedKeys) {
      expect(fields[key]).toBe((bundle as unknown as Record<string, unknown>)[key]);
    }
  });

  it("should_never_write_the_embedder_slug_or_tenancy_columns", () => {
    const fields = instanceScalarFields(bundle) as Record<string, unknown>;
    for (const key of ["embeddingProvider", "embeddingDim", "slug", "workspaceId", "id"]) {
      expect(key in fields).toBe(false);
    }
  });

  it("should_default_a_missing_icon_to_null_and_leave_other_absent_fields_undefined", () => {
    const fields = instanceScalarFields({ ...bundle, icon: undefined, attachmentStorageEnabled: undefined });
    expect(fields.icon).toBeNull();
    expect(fields.attachmentStorageEnabled).toBeUndefined();
  });
});
