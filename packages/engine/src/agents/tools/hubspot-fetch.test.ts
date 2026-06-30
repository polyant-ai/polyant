// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildPhoneFilterGroups, resolveOwnerNames } from "./hubspot-fetch.js";

describe("buildPhoneFilterGroups", () => {
  it("emits phone + mobilephone EQ groups for both +/no-+ E.164 variants", () => {
    const groups = buildPhoneFilterGroups("+14155550100");
    const flat = groups.flatMap((g) => g.filters);
    expect(flat).toContainEqual({ propertyName: "phone", operator: "EQ", value: "+14155550100" });
    expect(flat).toContainEqual({ propertyName: "mobilephone", operator: "EQ", value: "+14155550100" });
    expect(flat).toContainEqual({ propertyName: "phone", operator: "EQ", value: "14155550100" });
    expect(flat).toContainEqual({ propertyName: "mobilephone", operator: "EQ", value: "14155550100" });
  });

  it("adds a CONTAINS_TOKEN fallback on the last 10 digits when the input has >= 10 digits", () => {
    // A stored value whose country code diverges from the query still matches
    // on the digits-only mirror via the last 10 digits.
    const groups = buildPhoneFilterGroups("+1 (415) 555-0100");
    const fallback = groups
      .flatMap((g) => g.filters)
      .find((f) => f.propertyName === "hs_searchable_calculated_phone_number");
    expect(fallback).toEqual({
      propertyName: "hs_searchable_calculated_phone_number",
      operator: "CONTAINS_TOKEN",
      value: "4155550100",
    });
  });

  it("does NOT emit the CONTAINS_TOKEN fallback for short inputs (< 10 digits)", () => {
    // CONTAINS_TOKEN on a handful of digits would match too many unrelated contacts.
    const groups = buildPhoneFilterGroups("12345");
    const hasFallback = groups
      .flatMap((g) => g.filters)
      .some((f) => f.propertyName === "hs_searchable_calculated_phone_number");
    expect(hasFallback).toBe(false);
  });
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createOwnersResponse(
  body: string,
  opts?: { status?: number; headers?: Record<string, string> },
) {
  const headers = new Headers(opts?.headers ?? { "content-type": "application/json" });
  return {
    ok: (opts?.status ?? 200) < 400,
    status: opts?.status ?? 200,
    statusText: opts?.status && opts.status >= 400 ? "Error" : "OK",
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue(JSON.parse(body)),
    headers,
  } as unknown as Response;
}

const OWNERS_PAGE = JSON.stringify({
  results: [
    { id: "464905052", firstName: "Mario", lastName: "Rossi", email: "mario.rossi@acme.com" },
    { id: "464905099", firstName: "Anna", lastName: "Bianchi", email: "anna.bianchi@acme.com" },
  ],
});

describe("resolveOwnerNames", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("maps owner ids to name + email", async () => {
    mockFetch.mockResolvedValueOnce(createOwnersResponse(OWNERS_PAGE));

    const result = await resolveOwnerNames("key-map", ["464905052"]);

    expect(result.get("464905052")).toEqual({
      name: "Mario Rossi",
      email: "mario.rossi@acme.com",
    });
  });

  it("returns an empty map (no fetch) when given no ids", async () => {
    const result = await resolveOwnerNames("key-empty", []);

    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("queries the Owners API endpoint with a Bearer token", async () => {
    mockFetch.mockResolvedValueOnce(createOwnersResponse(OWNERS_PAGE));

    await resolveOwnerNames("key-endpoint", ["464905052"]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("https://api.hubapi.com/crm/v3/owners");
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: "Bearer key-endpoint",
    });
  });

  it("caches results within the TTL — no second fetch for the same id", async () => {
    mockFetch.mockResolvedValueOnce(createOwnersResponse(OWNERS_PAGE));

    const first = await resolveOwnerNames("key-cache", ["464905099"]);
    const second = await resolveOwnerNames("key-cache", ["464905099"]);

    expect(first.get("464905099")?.name).toBe("Anna Bianchi");
    expect(second.get("464905099")?.name).toBe("Anna Bianchi");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("omits unknown ids from the map", async () => {
    mockFetch.mockResolvedValueOnce(createOwnersResponse(OWNERS_PAGE));

    const result = await resolveOwnerNames("key-unknown", ["does-not-exist"]);

    expect(result.has("does-not-exist")).toBe(false);
  });

  it("returns an empty map when the Owners API call fails", async () => {
    mockFetch.mockResolvedValueOnce(
      createOwnersResponse(JSON.stringify({ message: "forbidden" }), { status: 403 }),
    );

    const result = await resolveOwnerNames("key-fail", ["464905052"]);

    expect(result.size).toBe(0);
  });
});
