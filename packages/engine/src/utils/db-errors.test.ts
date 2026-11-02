// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { isServerRejection, isUniqueViolation } from "./db-errors.js";

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

describe("isServerRejection", () => {
  // The class postgres-js throws when the server answers with an ErrorResponse.
  const serverError = () => new postgres.PostgresError({ message: "invalid input syntax", code: "22P02" } as never);

  it("is true for the driver's PostgresError, bare or wrapped on .cause (Drizzle 0.45 shape)", () => {
    expect(isServerRejection(serverError())).toBe(true);
    expect(isServerRejection(Object.assign(new Error("Failed query: insert into ..."), { cause: serverError() }))).toBe(true);
  });

  it("is false for a connection error, whose transaction may have committed", () => {
    // postgres-js Errors.connection, and a socket error from Node, bare and wrapped.
    const closed = Object.assign(new Error("write CONNECTION_CLOSED db:5432"), { code: "CONNECTION_CLOSED", errno: "CONNECTION_CLOSED" });
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", errno: -104 });
    expect(isServerRejection(closed)).toBe(false);
    expect(isServerRejection(reset)).toBe(false);
    expect(isServerRejection(Object.assign(new Error("Failed query"), { cause: reset }))).toBe(false);
  });

  it("is false for anything else", () => {
    expect(isServerRejection(new Error("plain error"))).toBe(false);
    expect(isServerRejection({ name: "PostgresError" })).toBe(false);
    expect(isServerRejection(undefined)).toBe(false);
  });
});
