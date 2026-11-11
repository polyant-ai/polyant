// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { isForeignKeyViolation, isUniqueViolation } from "./db-errors.js";

describe("isUniqueViolation", () => {
  it("returns true for an Error with .code === '23505' on the top level", () => {
    const err = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("returns true when the PostgresError is wrapped on .cause (Drizzle 0.45 shape)", () => {
    // Drizzle wraps the driver error: { stack, message, query, params, cause }
    const driverError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint_name: "instances_slug_unique",
    });
    const wrapped = Object.assign(new Error("Failed query: insert into ..."), {
      cause: driverError,
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("returns false for a different SQLSTATE code", () => {
    const err = Object.assign(new Error("foreign key violation"), { code: "23503" });
    expect(isUniqueViolation(err)).toBe(false);
  });

  it("returns false when .cause is a plain Error without a code", () => {
    const wrapped = Object.assign(new Error("wrapper"), { cause: new Error("inner") });
    expect(isUniqueViolation(wrapped)).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation({ code: "23505" })).toBe(false);
  });

  it("returns false for an Error with no code anywhere", () => {
    expect(isUniqueViolation(new Error("plain error"))).toBe(false);
  });
});

describe("isForeignKeyViolation", () => {
  it("returns true when the driver error with code 23503 is wrapped on .cause", () => {
    const driverError = Object.assign(new Error("insert or update violates foreign key constraint"), { code: "23503" });
    const wrapped = Object.assign(new Error("Failed query: insert into ..."), { cause: driverError });
    expect(isForeignKeyViolation(wrapped)).toBe(true);
  });

  it("returns false for a unique violation", () => {
    expect(isForeignKeyViolation(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
  });
});
