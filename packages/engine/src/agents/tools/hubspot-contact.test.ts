// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import hubspotContactTool from "./hubspot-contact.tool.js";
import { buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

function createMockResponse(
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

const ctxWithKey = {
  instanceId: "test",
  secrets: { hubspot_api_key: "test-api-key" },
  audit: createMockAudit(),
} as any;

const toolCtx = { toolCallId: "tc-1", messages: [] } as any;

describe("hubspotContact", () => {
  const def = hubspotContactTool;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("is registered with correct metadata", () => {
    expect(def).toBeDefined();
    expect(def.name).toBe("hubspotContact");
    expect(def.category).toBe("crm");
    expect(def.requiredSecrets).toEqual([{ key: "hubspot_api_key", type: "text", sensitive: true }]);
  });

  it("has parameters and description", () => {
    const tool = buildTool(def, ctxWithKey) as any;
    expect(tool.description).toBeDefined();
    expect(tool.inputSchema).toBeDefined();
  });

  it("writes customProperties to HubSpot on create", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ id: "c-42", properties: {} })),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const result = await tool.execute(
      {
        action: "create",
        contactId: null,
        firstName: "Mario",
        lastName: "Rossi",
        phone: "+39 333 1234567",
        email: "mario@example.com",
        companyId: null,
        name: null,
        customProperties: { evento: "spring-conference-2026" },
      },
      toolCtx,
    );

    expect(result.success).toBe(true);
    expect(result.contact.id).toBe("c-42");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.hubapi.com/crm/v3/objects/contacts");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.properties.firstname).toBe("Mario");
    expect(body.properties.evento).toBe("spring-conference-2026");
  });

  it("writes customProperties to HubSpot on update", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ id: "c-99", properties: {} })),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const result = await tool.execute(
      {
        action: "update",
        contactId: "c-99",
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: { evento: "spring-conference-2026" },
      },
      toolCtx,
    );

    expect(result.success).toBe(true);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.hubapi.com/crm/v3/objects/contacts/c-99");
    expect(opts.method).toBe("PATCH");
    const body = JSON.parse(opts.body);
    expect(body.properties.evento).toBe("spring-conference-2026");
  });

  it("searches with filters only (no phone/name/email)", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 1,
            results: [
              { id: "c-1", properties: { firstname: "Mario", lastname: "Rossi", phone: null, email: null } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const result = await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: [{ property: "evento", propertyName: null, operator: "EQ", value: "spring-conference-2026" }],
      },
      toolCtx,
    );

    expect(result.found).toBe(1);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.filterGroups).toEqual([
      { filters: [{ propertyName: "evento", operator: "EQ", value: "spring-conference-2026" }] },
    ]);
  });

  it("accepts 'propertyName' as an alias for 'property' in filters (LLM tolerance)", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 1,
            results: [
              { id: "c-1", properties: { firstname: null, lastname: null, phone: null, email: "jane@example.com" } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    // The model emitted `propertyName` (HubSpot raw API name) instead of
    // the tool's `property` field. `execute` must coalesce it to `property`
    // at runtime — otherwise the call would fail with "filters[0].property
    // required" (the original production error). The coalescence used to be
    // a Zod `.transform()`; it now lives in `execute`, so we call execute
    // directly with the raw args.
    const rawArgs = {
      action: "search",
      contactId: null,
      firstName: null,
      lastName: null,
      phone: null,
      filters: [{ property: null, propertyName: "email", operator: "EQ", value: "jane@example.com" }],
      email: null,
      companyId: null,
      name: null,
      customProperties: null,
      returnProperties: null,
      limit: null,
      after: null,
    };
    const result = await tool.execute(rawArgs as any, toolCtx);

    expect(result.found).toBe(1);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.filterGroups).toEqual([
      { filters: [{ propertyName: "email", operator: "EQ", value: "jane@example.com" }] },
    ]);
  });

  it("searches with filters combined AND with phone", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ total: 0, results: [] })),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: "+39 333 1234567",
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: [{ property: "evento", propertyName: null, operator: "EQ", value: "spring-conference-2026" }],
      },
      toolCtx,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    // Phone with "+" produces 4 EQ filterGroups (phone/mobilephone × with+/without+),
    // plus a fallback CONTAINS_TOKEN on hs_searchable_calculated_phone_number,
    // each with the custom evento filter AND-ed in.
    expect(body.filterGroups).toEqual([
      {
        filters: [
          { propertyName: "phone", operator: "EQ", value: "+393331234567" },
          { propertyName: "evento", operator: "EQ", value: "spring-conference-2026" },
        ],
      },
      {
        filters: [
          { propertyName: "mobilephone", operator: "EQ", value: "+393331234567" },
          { propertyName: "evento", operator: "EQ", value: "spring-conference-2026" },
        ],
      },
      {
        filters: [
          { propertyName: "phone", operator: "EQ", value: "393331234567" },
          { propertyName: "evento", operator: "EQ", value: "spring-conference-2026" },
        ],
      },
      {
        filters: [
          { propertyName: "mobilephone", operator: "EQ", value: "393331234567" },
          { propertyName: "evento", operator: "EQ", value: "spring-conference-2026" },
        ],
      },
      {
        filters: [
          { propertyName: "hs_searchable_calculated_phone_number", operator: "CONTAINS_TOKEN", value: "3331234567" },
          { propertyName: "evento", operator: "EQ", value: "spring-conference-2026" },
        ],
      },
    ]);
  });

  it("phone with leading + emits both + and non-+ filter groups (phone & mobilephone)", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ total: 1, results: [{ id: "c-42", properties: { firstname: "Paolo", phone: "+390000000001" } }] })),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: "+39 000 0000001",
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
      },
      toolCtx,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.filterGroups).toEqual([
      { filters: [{ propertyName: "phone", operator: "EQ", value: "+390000000001" }] },
      { filters: [{ propertyName: "mobilephone", operator: "EQ", value: "+390000000001" }] },
      { filters: [{ propertyName: "phone", operator: "EQ", value: "390000000001" }] },
      { filters: [{ propertyName: "mobilephone", operator: "EQ", value: "390000000001" }] },
      { filters: [{ propertyName: "hs_searchable_calculated_phone_number", operator: "CONTAINS_TOKEN", value: "0000000001" }] },
    ]);
  });

  it("phone without leading + emits only non-+ filter groups (no duplicates)", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ total: 0, results: [] })),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: "390000000001",
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
      },
      toolCtx,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.filterGroups).toEqual([
      { filters: [{ propertyName: "phone", operator: "EQ", value: "390000000001" }] },
      { filters: [{ propertyName: "mobilephone", operator: "EQ", value: "390000000001" }] },
      { filters: [{ propertyName: "hs_searchable_calculated_phone_number", operator: "CONTAINS_TOKEN", value: "0000000001" }] },
    ]);
  });

  it("phone fallback recovers contacts whose stored value diverges in country-code", async () => {
    // Real-world case: a contact saved in HubSpot missing the IT country code
    // (10 digits) while the caller passes the "normalized" full number. EQ
    // filters miss; the CONTAINS_TOKEN fallback on the last 10 digits hits
    // hs_searchable_calculated_phone_number.
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ total: 0, results: [] })),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: "+390000000002",
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
      },
      toolCtx,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.filterGroups).toContainEqual({
      filters: [
        { propertyName: "hs_searchable_calculated_phone_number", operator: "CONTAINS_TOKEN", value: "0000000002" },
      ],
    });
  });

  it("short phone numbers (<10 digits) do not emit the CONTAINS_TOKEN fallback", async () => {
    // Guard: avoid overly permissive matches when the caller passes only a few
    // digits — CONTAINS_TOKEN on 5 digits would match too many unrelated contacts.
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ total: 0, results: [] })),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: "12345",
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
      },
      toolCtx,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    for (const g of body.filterGroups) {
      for (const f of g.filters) {
        expect(f.propertyName).not.toBe("hs_searchable_calculated_phone_number");
      }
    }
  });

  it("filters[] tolerates LLMs that omit propertyName entirely (no key at all)", async () => {
    // Real production failure on gpt-4.1-mini: the model emitted
    //   filters: [{ property: "email", operator: "EQ", value: "..." }]
    // (no propertyName key at all). `execute` reads `f.property ?? f.propertyName`,
    // so a missing `propertyName` is harmless (undefined ?? => property wins).
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 1,
            results: [
              { id: "c-1", properties: { firstname: null, lastname: null, phone: null, email: "x@y.com" } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const rawArgs = {
      action: "search",
      contactId: null,
      firstName: null,
      lastName: null,
      phone: null,
      email: null,
      companyId: null,
      name: null,
      customProperties: null,
      // NOTE: propertyName key is missing entirely — mimics gpt-4.1-mini's bug.
      filters: [{ property: "email", operator: "EQ", value: "x@y.com" }],
      returnProperties: null,
      limit: null,
      after: null,
    };
    const result = await tool.execute(rawArgs as any, toolCtx);

    expect(result.found).toBe(1);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.filterGroups).toEqual([
      { filters: [{ propertyName: "email", operator: "EQ", value: "x@y.com" }] },
    ]);
  });

  it("filters[] tolerates LLMs that omit property entirely (only propertyName provided)", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 1,
            results: [
              { id: "c-9", properties: { firstname: null, lastname: null, phone: null, email: "a@b.com" } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const rawArgs = {
      action: "search",
      contactId: null,
      firstName: null,
      lastName: null,
      phone: null,
      email: null,
      companyId: null,
      name: null,
      customProperties: null,
      // Inverse: only the alias key is present.
      filters: [{ propertyName: "email", operator: "EQ", value: "a@b.com" }],
      returnProperties: null,
      limit: null,
      after: null,
    };
    const result = await tool.execute(rawArgs as any, toolCtx);

    expect(result.found).toBe(1);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.filterGroups).toEqual([
      { filters: [{ propertyName: "email", operator: "EQ", value: "a@b.com" }] },
    ]);
  });

  it("search by contactId only — translates to hs_object_id EQ filter (get-by-id)", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 1,
            results: [
              {
                id: "777327358179",
                properties: {
                  firstname: "Jane",
                  lastname: "Doe",
                  phone: null,
                  email: "jane.doe@example.com",
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const result = await tool.execute(
      {
        action: "search",
        contactId: "777327358179",
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
      },
      toolCtx,
    );

    expect(result.found).toBe(1);
    expect(result.contacts[0].id).toBe("777327358179");
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.filterGroups).toEqual([
      { filters: [{ propertyName: "hs_object_id", operator: "EQ", value: "777327358179" }] },
    ]);
  });

  it("returns error when search has no criteria at all", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    const result = await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
      },
      toolCtx,
    );

    expect(result.error).toContain("at least one search criterion");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("includes returnProperties in search request and result", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 1,
            results: [
              {
                id: "c-77",
                properties: {
                  firstname: "Luca",
                  lastname: "Verdi",
                  phone: null,
                  email: null,
                  evento: "spring-conference-2026",
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const result = await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: [{ property: "evento", operator: "EQ", value: "spring-conference-2026" }],
        returnProperties: ["evento"],
      },
      toolCtx,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.properties).toEqual(
      expect.arrayContaining(["firstname", "lastname", "phone", "mobilephone", "email", "hs_object_id", "evento"]),
    );

    expect(result.contacts[0].customProperties).toEqual({ evento: "spring-conference-2026" });
  });

  it("respects limit and after parameters in search", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 250,
            results: [{ id: "c-1", properties: { firstname: "A", lastname: "B", phone: null, email: null } }],
            paging: { next: { after: "cursor-xyz" } },
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const result = await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: [{ property: "evento", operator: "EQ", value: "spring-conference-2026" }],
        returnProperties: null,
        limit: 100,
        after: "previous-cursor",
      },
      toolCtx,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.limit).toBe(100);
    expect(body.after).toBe("previous-cursor");
    expect(result.nextAfter).toBe("cursor-xyz");
  });

  it("enriches search results that carry hubspot_owner_id with owner_name/owner_email", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    // Route by URL so the test is independent of whether the module-level
    // portal-id cache is already warm from a previous test (which would
    // otherwise skip the account-info fetch and shift the call ordering).
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/contacts/search")) {
        return Promise.resolve(
          createMockResponse(
            JSON.stringify({
              total: 1,
              results: [
                {
                  id: "c-owned",
                  properties: {
                    firstname: "Jane",
                    lastname: "Doe",
                    phone: null,
                    email: "jane@example.com",
                    hubspot_owner_id: "owner-enrich-1",
                  },
                },
              ],
            }),
          ),
        );
      }
      if (u.includes("/crm/v3/owners")) {
        return Promise.resolve(
          createMockResponse(
            JSON.stringify({
              results: [
                { id: "owner-enrich-1", firstName: "Mario", lastName: "Rossi", email: "mario.rossi@acme.com" },
              ],
            }),
          ),
        );
      }
      return Promise.resolve(createMockResponse(JSON.stringify({ portalId: 11111111 })));
    });

    const result = await tool.execute(
      {
        action: "search",
        contactId: "c-owned",
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
        returnProperties: null,
        limit: null,
        after: null,
      },
      toolCtx,
    );

    expect(result.contacts[0].hubspot_owner_id).toBe("owner-enrich-1"); // retained — backward-compatible
    expect(result.contacts[0].owner_name).toBe("Mario Rossi");
    expect(result.contacts[0].owner_email).toBe("mario.rossi@acme.com");

    // The Owners API was queried.
    const ownersCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/crm/v3/owners"));
    expect(ownersCall).toBeDefined();
  });

  it("makes NO Owners API call when no result carries an owner", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 1,
            results: [
              { id: "c-noowner", properties: { firstname: "Luca", lastname: "Verdi", phone: null, email: null } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    const result = await tool.execute(
      {
        action: "search",
        contactId: "c-noowner",
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
        returnProperties: null,
        limit: null,
        after: null,
      },
      toolCtx,
    );

    expect(result.found).toBe(1);
    expect(result.contacts[0].owner_name).toBeUndefined();
    const ownersCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/crm/v3/owners"));
    expect(ownersCall).toBeUndefined();
  });

  it("clamps limit to 100 and defaults to 10", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ total: 0, results: [] })),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: null,
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: [{ property: "evento", operator: "EQ", value: "spring-conference-2026" }],
        returnProperties: null,
        limit: 500,
        after: null,
      },
      toolCtx,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.limit).toBe(100);
    expect(body.after).toBeUndefined();
  });

  it("works without any of the new parameters (backward compat)", async () => {
    const tool = buildTool(def, ctxWithKey) as any;

    mockFetch
      .mockResolvedValueOnce(
        createMockResponse(
          JSON.stringify({
            total: 1,
            results: [
              { id: "c-legacy", properties: { firstname: "Paolo", lastname: "V", phone: "393331234567", email: null } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createMockResponse(JSON.stringify({ portalId: 11111111 })),
      );

    // Call exactly as old callers would — no customProperties, filters, returnProperties, limit, after
    const result = await tool.execute(
      {
        action: "search",
        contactId: null,
        firstName: null,
        lastName: null,
        phone: "+39 333 1234567",
        email: null,
        companyId: null,
        name: null,
        customProperties: null,
        filters: null,
        returnProperties: null,
        limit: null,
        after: null,
      },
      toolCtx,
    );

    expect(result.found).toBe(1);
    expect(result.contacts[0].firstName).toBe("Paolo");
    expect(result.contacts[0].customProperties).toBeUndefined(); // no extraProperties → no customProperties in result
    expect(result.nextAfter).toBeUndefined();

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.limit).toBe(10); // default
    expect(body.after).toBeUndefined();
  });
});
