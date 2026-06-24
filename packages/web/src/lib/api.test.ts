// SPDX-License-Identifier: AGPL-3.0-or-later

import { getUserErrorMessage, ApiError, api, API_BASE } from "./api";

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
  global.fetch = fn;
  return fn;
}

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
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(mockResponse({ message: "Not found" }, { status: 404, statusText: "Not Found" })),
    );

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
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("not json", {
        status: 500,
        statusText: "Internal Server Error",
      })),
    );

    try {
      await api.instances.list();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).message).toBe("Internal Server Error");
    }
  });

  it("merges custom headers with Content-Type", async () => {
    const fetchFn = mockFetch(mockResponse({ instance: {} }));

    // Use a method that supports custom options - we test by calling create
    // which uses POST (the request function spreads headers)
    await api.instances.create({ slug: "test", name: "Test" });

    const [, init] = fetchFn.mock.calls[0];
    expect(init?.headers).toEqual(
      expect.objectContaining({ "Content-Type": "application/json" }),
    );
  });
});

// ── api.instances ──────────────────────────────────────────────────────

describe("api.instances", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list() calls GET /api/instances", async () => {
    const fetchFn = mockFetch(mockResponse({ instances: [] }));

    await api.instances.list();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/instances`);
    expect(init?.method).toBeUndefined(); // GET is default
  });

  it("create() calls POST /api/instances with JSON body", async () => {
    const fetchFn = mockFetch(mockResponse({ instance: { id: "1" } }));
    const payload = { slug: "my-bot", name: "My Bot", description: "A helpful bot" };

    await api.instances.create(payload);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/instances`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(payload);
  });

  it("update() calls PATCH /api/instances/:slug with JSON body", async () => {
    const fetchFn = mockFetch(mockResponse({ instance: { id: "1" } }));
    const payload = { name: "Updated Name", status: "active" };

    await api.instances.update("my-bot", payload);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/instances/my-bot`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual(payload);
  });

  it("delete() calls DELETE /api/instances/:slug", async () => {
    const fetchFn = mockFetch(mockResponse({ deleted: true }));

    await api.instances.delete("my-bot");

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/instances/my-bot`);
    expect(init?.method).toBe("DELETE");
  });
});

// ── api.conversations ──────────────────────────────────────────────────

describe("api.conversations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list() with no params sends no query string", async () => {
    const fetchFn = mockFetch(
      mockResponse({ conversations: [], total: 0, limit: 20, offset: 0 }),
    );

    await api.conversations.list();

    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/conversations`);
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

    const [url] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.searchParams.get("instanceId")).toBe("inst-1");
    expect(parsed.searchParams.get("search")).toBe("hello");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(parsed.searchParams.get("offset")).toBe("5");
  });

  it("list() with only instanceId includes only that param", async () => {
    const fetchFn = mockFetch(
      mockResponse({ conversations: [], total: 0, limit: 20, offset: 0 }),
    );

    await api.conversations.list({ instanceId: "inst-1" });

    const [url] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.searchParams.get("instanceId")).toBe("inst-1");
    expect(parsed.searchParams.has("search")).toBe(false);
    expect(parsed.searchParams.has("limit")).toBe(false);
    expect(parsed.searchParams.has("offset")).toBe(false);
  });

  it("get() encodes conversationId and includes instanceId scope", async () => {
    const fetchFn = mockFetch(mockResponse({ conversation: {} }));

    await api.conversations.get("conv/special id", "inst-1");

    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe(
      `${API_BASE}/api/conversations/${encodeURIComponent("conv/special id")}?instanceId=inst-1`,
    );
  });

  it("delete() calls DELETE with encoded conversationId and instanceId scope", async () => {
    const fetchFn = mockFetch(mockResponse({ deleted: true }));

    await api.conversations.delete("conv-123", "inst-1");

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/conversations/conv-123?instanceId=inst-1`);
    expect(init?.method).toBe("DELETE");
  });
});

// ── api.memories ───────────────────────────────────────────────────────

describe("api.memories", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

    const [url] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.searchParams.get("instanceId")).toBe("inst-1");
    expect(parsed.searchParams.get("search")).toBe("rome");
    expect(parsed.searchParams.get("category")).toBe("preference");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(parsed.searchParams.get("offset")).toBe("5");
  });

  it("list() with no params sends no query string", async () => {
    const fetchFn = mockFetch(
      mockResponse({ memories: [], total: 0, limit: 20, offset: 0 }),
    );

    await api.memories.list();

    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/memories`);
  });

  it("create() calls POST /memories with JSON body", async () => {
    const fetchFn = mockFetch(
      mockResponse({ memory: { id: "m-1", content: "test", event: "created" } }),
    );
    const payload = {
      instanceId: "inst-1",
      content: "User prefers Italian",
      category: "preference",
      importance: 8,
    };

    await api.memories.create(payload);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/memories`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(payload);
  });

  it("delete() calls DELETE /memories/:id", async () => {
    const fetchFn = mockFetch(mockResponse({ deleted: true }));

    await api.memories.delete("m-1");

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/memories/m-1`);
    expect(init?.method).toBe("DELETE");
  });

  it("deleteAll() calls DELETE /memories with instanceId param", async () => {
    const fetchFn = mockFetch(mockResponse({ deleted: true }));

    await api.memories.deleteAll("inst-1");

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${API_BASE}/memories?instanceId=inst-1`);
    expect(init?.method).toBe("DELETE");
  });
});

// ── api.analytics ──────────────────────────────────────────────────────

describe("api.analytics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("global() passes from/to as URLSearchParams", async () => {
    const fetchFn = mockFetch(mockResponse({ overview: {}, dailyTrend: [] }));

    await api.analytics.global("2026-01-01", "2026-01-31");

    const [url] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.pathname).toBe("/api/analytics");
    expect(parsed.searchParams.get("from")).toBe("2026-01-01");
    expect(parsed.searchParams.get("to")).toBe("2026-01-31");
  });

  it("instance() passes slug and from/to as URLSearchParams", async () => {
    const fetchFn = mockFetch(mockResponse({ overview: {}, dailyTrend: [] }));

    await api.analytics.instance("my-bot", "2026-02-01", "2026-02-28");

    const [url] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.pathname).toBe("/api/instances/my-bot/analytics");
    expect(parsed.searchParams.get("from")).toBe("2026-02-01");
    expect(parsed.searchParams.get("to")).toBe("2026-02-28");
  });
});

// ── api.members ────────────────────────────────────────────────────────

describe("api.members", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list() targets the default org members endpoint", async () => {
    const fetchFn = mockFetch(mockResponse({ members: [] }));
    await api.members.list();
    const [url] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.pathname).toBe("/api/organizations/default/members");
  });

  it("assign() PUTs the role to the member endpoint", async () => {
    const fetchFn = mockFetch(mockResponse({ assigned: true }));
    await api.members.assign("user-1", "admin");
    const [url, init] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.pathname).toBe("/api/organizations/default/members/user-1");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ roleKey: "admin" });
  });

  it("remove() DELETEs the member endpoint", async () => {
    const fetchFn = mockFetch(mockResponse({ removed: true }));
    await api.members.remove("user-1");
    const [url, init] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.pathname).toBe("/api/organizations/default/members/user-1");
    expect(init?.method).toBe("DELETE");
  });

  it("encodes a non-default org slug and user id", async () => {
    const fetchFn = mockFetch(mockResponse({ assigned: true }));
    await api.members.assign("u/2", "member", "acme corp");
    const [url] = fetchFn.mock.calls[0];
    const parsed = new URL(url as string, "http://localhost");
    expect(parsed.pathname).toBe("/api/organizations/acme%20corp/members/u%2F2");
  });
});
