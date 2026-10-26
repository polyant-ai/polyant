// SPDX-License-Identifier: AGPL-3.0-or-later

import { getUserErrorMessage, isForbidden, ApiError, api } from "./api";

describe("isForbidden", () => {
  it("recognises the engine refusing on authorization grounds", () => {
    expect(isForbidden(new ApiError(403, "Missing permission: audit_log:read"))).toBe(true);
  });

  // 401 is "who are you", and its remedy differs — sign in again, which
  // `TenantUnavailable` already offers. Conflating the two would tell someone
  // whose session merely expired to go ask an administrator for a role.
  it("does not treat an expired session as a permission problem", () => {
    expect(isForbidden(new ApiError(401, "Authentication required"))).toBe(false);
  });

  it("is false for other API failures and for non-API errors", () => {
    expect(isForbidden(new ApiError(500, "boom"))).toBe(false);
    expect(isForbidden(new Error("network"))).toBe(false);
    expect(isForbidden(undefined)).toBe(false);
  });
});

describe("getUserErrorMessage", () => {
  it("returns short, clean ApiError messages", () => {
    const err = new ApiError(400, "Instance not found");
    expect(getUserErrorMessage(err, "default")).toBe("Instance not found");
  });

  it("returns fallback for long ApiError messages", () => {
    const longMsg = "a".repeat(250);
    const err = new ApiError(500, longMsg);
    expect(getUserErrorMessage(err, "Something went wrong")).toBe("Something went wrong");
  });

  it("returns fallback for messages containing stack traces", () => {
    const err = new ApiError(500, "at Object.handler (/app/server/index.ts:45:12)");
    expect(getUserErrorMessage(err, "fallback")).toBe("fallback");
  });

  it("returns fallback for messages with Error: prefix", () => {
    const err = new ApiError(500, "Error: ECONNREFUSED 127.0.0.1:5432");
    expect(getUserErrorMessage(err, "fallback")).toBe("fallback");
  });

  it("returns fallback for messages with file paths", () => {
    const err = new ApiError(500, "Cannot read /usr/local/config");
    expect(getUserErrorMessage(err, "fallback")).toBe("fallback");
  });

  it("returns timeout message for TimeoutError", () => {
    const err = new Error("signal timed out");
    err.name = "TimeoutError";
    expect(getUserErrorMessage(err, "fallback")).toBe("Request timed out. Please try again.");
  });

  it("returns fallback for unknown error types", () => {
    expect(getUserErrorMessage("string error", "fallback")).toBe("fallback");
    expect(getUserErrorMessage(42, "fallback")).toBe("fallback");
    expect(getUserErrorMessage(null, "fallback")).toBe("fallback");
  });

  it("returns fallback for regular Error (non-ApiError)", () => {
    const err = new Error("something broke");
    expect(getUserErrorMessage(err, "fallback")).toBe("fallback");
  });
});

// ── Helpers for fetch mocking ──────────────────────────────────────────

function mockResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function mockFetch(response: Response) {
  const fn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

// ── the workspace header ───────────────────────────────────────────────

/**
 * `request()` derives the workspace from the URL being rendered and sends it as
 * `X-Workspace-Slug`. That single line is what makes the URL segment
 * authoritative instead of decorative, and the alternative it replaced (a
 * cookie) failed precisely by disagreeing with the address bar — so it is worth
 * pinning here rather than only end to end.
 */
describe("request() — workspace scoping", () => {
  // Navigate the real jsdom location rather than replacing `window.location`:
  // the property is not configurable inside an isolated VM context.
  function at(pathname: string) {
    window.history.pushState({}, "", pathname);
  }

  afterEach(() => {
    window.history.pushState({}, "", "/");
    vi.restoreAllMocks();
  });

  function headerFrom(fetchFn: ReturnType<typeof mockFetch>): string | undefined {
    const init = fetchFn.mock.calls[0][1];
    return (init?.headers as Record<string, string> | undefined)?.["X-Workspace-Slug"];
  }

  it("sends the workspace the URL addresses", async () => {
    at("/organizations/acme/workspaces/sales/instances");
    const fetchFn = mockFetch(mockResponse({ instances: [] }));

    await api.instances.list();

    expect(headerFrom(fetchFn)).toBe("sales");
  });

  it("sends no workspace header from an org-level page", async () => {
    // The caller's stored preference resolves it server-side; sending a stale
    // workspace here is exactly the divergence this mechanism removes.
    at("/organizations/acme/members");
    const fetchFn = mockFetch(mockResponse({ members: [] }));

    await api.members.list("acme");

    expect(headerFrom(fetchFn)).toBeUndefined();
  });

  it("sends no workspace header from a deployment-level page", async () => {
    at("/settings");
    const fetchFn = mockFetch(mockResponse({ organization: null, workspaces: [] }));

    await api.me.get();

    // Empty, which the engine reads as absent.
    expect(headerFrom(fetchFn)).toBeFalsy();
  });

  it("asks for the caller's tenancy without naming the tenant in the address", async () => {
    // A mistyped workspace in the URL used to make the engine answer 403 here, which
    // the panel showed as "you belong to no organization" instead of a 404.
    at("/organizations/acme/workspaces/typo/instances");
    const fetchFn = mockFetch(mockResponse({ organizations: [] }));

    await api.me.get();

    const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-Workspace-Slug"]).toBe("");
  });

  it("decodes the segment — the header carries the raw slug", async () => {
    at("/organizations/acme/workspaces/a%20b/memory");
    const fetchFn = mockFetch(mockResponse({ memories: [] }));

    await api.instances.list();

    expect(headerFrom(fetchFn)).toBe("a b");
  });
});

// ── request() (tested via api methods) ─────────────────────────────────

describe("request() via api methods", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on successful response", async () => {
    const data = { instances: [{ id: "1", slug: "test" }] };
    mockFetch(mockResponse(data));

    const result = await api.instances.list();
    expect(result).toEqual(data);
  });

  it("sets Content-Type: application/json header", async () => {
    const fetchFn = mockFetch(mockResponse({ instances: [] }));

    await api.instances.list();

    const [, init] = fetchFn.mock.calls[0];
    expect(init?.headers).toEqual(
      expect.objectContaining({ "Content-Type": "application/json" }),
    );
  });

  it("throws ApiError with body.message on non-ok JSON response", async () => {
    // Return a fresh Response per call so the body stream isn't consumed twice
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(mockResponse({ message: "Not found" }, { status: 404, statusText: "Not Found" })),
    ));

    try {
      await api.instances.get("missing");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).message).toBe("Not found");
    }
  });

  it("throws ApiError with statusText when response body is unparseable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("not json", {
        status: 500,
        statusText: "Internal Server Error",
      })),
    ));

    try {
      await api.instances.list();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).message).toBe("Internal Server Error");
    }
  });
});

// ── what the client adds beyond the route ─────────────────────────────
//
// Which method and path each function calls is checked against the engine's
// own route table by `api-contract.test.ts`. What follows is what that guard
// cannot see: query strings, scoping parameters, encoding and body shape.

function sentUrl(fetchFn: ReturnType<typeof mockFetch>): URL {
  return new URL(fetchFn.mock.calls[0][0] as string, "http://localhost");
}

describe("api.conversations", () => {
  it("list() with no params sends no query string", async () => {
    const fetchFn = mockFetch(
      mockResponse({ conversations: [], total: 0, limit: 20, offset: 0 }),
    );

    await api.conversations.list();

    expect(sentUrl(fetchFn).search).toBe("");
  });

  it("list() with all params builds correct URLSearchParams", async () => {
    const fetchFn = mockFetch(
      mockResponse({ conversations: [], total: 0, limit: 10, offset: 5 }),
    );

    await api.conversations.list({
      instanceId: "inst-1",
      search: "hello",
      limit: 10,
      offset: 5,
    });

    const { searchParams } = sentUrl(fetchFn);
    expect(searchParams.get("instanceId")).toBe("inst-1");
    expect(searchParams.get("search")).toBe("hello");
    expect(searchParams.get("limit")).toBe("10");
    expect(searchParams.get("offset")).toBe("5");
  });

  it("list() with only instanceId includes only that param", async () => {
    const fetchFn = mockFetch(
      mockResponse({ conversations: [], total: 0, limit: 20, offset: 0 }),
    );

    await api.conversations.list({ instanceId: "inst-1" });

    expect([...sentUrl(fetchFn).searchParams.keys()]).toEqual(["instanceId"]);
  });

  it("get() encodes conversationId and includes instanceId scope", async () => {
    const fetchFn = mockFetch(mockResponse({ conversation: {} }));

    await api.conversations.get("conv/special id", "inst-1");

    const url = sentUrl(fetchFn);
    expect(url.pathname.endsWith("/conv%2Fspecial%20id")).toBe(true);
    expect(url.searchParams.get("instanceId")).toBe("inst-1");
  });

  // A conversation id is only unique within an agent: without the scope the
  // delete would be ambiguous.
  it("delete() carries the instanceId scope", async () => {
    const fetchFn = mockFetch(mockResponse({ deleted: true }));

    await api.conversations.delete("conv-123", "inst-1");

    expect(sentUrl(fetchFn).searchParams.get("instanceId")).toBe("inst-1");
  });
});

describe("api.memories", () => {
  it("list() with all params builds correct query string", async () => {
    const fetchFn = mockFetch(
      mockResponse({ memories: [], total: 0, limit: 20, offset: 0 }),
    );

    await api.memories.list({
      instanceId: "inst-1",
      search: "rome",
      category: "preference",
      limit: 10,
      offset: 5,
    });

    const { searchParams } = sentUrl(fetchFn);
    expect(searchParams.get("instanceId")).toBe("inst-1");
    expect(searchParams.get("search")).toBe("rome");
    expect(searchParams.get("category")).toBe("preference");
    expect(searchParams.get("limit")).toBe("10");
    expect(searchParams.get("offset")).toBe("5");
  });

  it("list() with no params sends no query string", async () => {
    const fetchFn = mockFetch(
      mockResponse({ memories: [], total: 0, limit: 20, offset: 0 }),
    );

    await api.memories.list();

    expect(sentUrl(fetchFn).search).toBe("");
  });

  // The bulk delete is bounded by this parameter alone.
  it("deleteAll() scopes the bulk delete to one agent", async () => {
    const fetchFn = mockFetch(mockResponse({ deleted: true }));

    await api.memories.deleteAll("inst-1");

    expect(sentUrl(fetchFn).searchParams.get("instanceId")).toBe("inst-1");
  });
});

describe("api.analytics", () => {
  it("global() passes from/to as URLSearchParams", async () => {
    const fetchFn = mockFetch(mockResponse({ overview: {}, dailyTrend: [] }));

    await api.analytics.global("2026-01-01", "2026-01-31");

    const { searchParams } = sentUrl(fetchFn);
    expect(searchParams.get("from")).toBe("2026-01-01");
    expect(searchParams.get("to")).toBe("2026-01-31");
  });

  it("instance() passes slug and from/to as URLSearchParams", async () => {
    const fetchFn = mockFetch(mockResponse({ overview: {}, dailyTrend: [] }));

    await api.analytics.instance("my-bot", "2026-02-01", "2026-02-28");

    const url = sentUrl(fetchFn);
    expect(url.pathname).toContain("/my-bot/");
    expect(url.searchParams.get("from")).toBe("2026-02-01");
    expect(url.searchParams.get("to")).toBe("2026-02-28");
  });
});

describe("api.members", () => {
  it("assign() sends the role as roleKey", async () => {
    const fetchFn = mockFetch(mockResponse({ assigned: true }));

    await api.members.assign("user-1", "admin", "acme");

    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({ roleKey: "admin" });
  });

  // These deliberately avoid the slug "default": it is the value the deleted
  // DEFAULT_ORG_SLUG constant used to hardcode, so asserting it cannot tell
  // "uses the argument" from "still hardcodes the default".
  it("encodes a non-default org slug and user id", async () => {
    const fetchFn = mockFetch(mockResponse({ assigned: true }));

    await api.members.assign("u/2", "member", "acme corp");

    expect(sentUrl(fetchFn).pathname).toBe("/api/organizations/acme%20corp/members/u%2F2");
  });
});

// The room backlog and activity routes validate `limit` as 1..200 and answer 400
// for 0, so a zero limit is left out of the query like an absent one. Offset 0 is valid.
describe("room list queries", () => {
  async function urlOf(call: () => Promise<unknown>): Promise<string> {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await call();
      return String(fetchMock.mock.calls[0][0]);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("leaves a zero limit out of the backlog query and keeps a zero offset", async () => {
    expect(await urlOf(() => api.room.backlog("acme", { limit: 0, offset: 0 }))).toBe(
      "/api/instances/acme/room/backlog?offset=0",
    );
    expect(await urlOf(() => api.room.backlog("acme", { limit: 20 }))).toBe(
      "/api/instances/acme/room/backlog?limit=20",
    );
  });

  it("leaves a zero limit out of the activity query", async () => {
    expect(await urlOf(() => api.room.activity("acme", { logType: "daily", limit: 0 }))).toBe(
      "/api/instances/acme/room/activity?logType=daily",
    );
  });
});
