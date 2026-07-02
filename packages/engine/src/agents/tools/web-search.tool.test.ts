// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock `ai` so registerTool doesn't try to materialize a real Vercel AI SDK tool.
vi.mock("ai", () => ({
  tool: vi.fn((opts: any) => ({ _type: "mock-tool", ...opts })),
}));

// Mock `fs` so the registry's auto-loader doesn't scan the real filesystem
// when other tests import it transitively.
vi.mock("fs", () => ({
  readdirSync: vi.fn(() => []),
}));

// Tavily client mock — we control what `client.search(query, opts)` returns.
const mockTavilySearch = vi.fn();
vi.mock("@tavily/core", () => ({
  tavily: vi.fn(() => ({ search: mockTavilySearch })),
}));

import { type ToolContext } from "./registry.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

import webSearchTool from "./web-search.tool.js";

// ── Helpers ────────────────────────────────────────────────────────────

const auditLog = vi.fn();
const noopAudit = { log: auditLog };

function makeCtx(secrets: Record<string, string>): ToolContext {
  return {
    instanceId: asInstanceSlug("test-instance"),
    secrets,
    audit: noopAudit as any,
  };
}

function getWebSearch() {
  return webSearchTool;
}

const INPUT_QUERY = "polyant framework";

async function runWebSearch(secrets: Record<string, string>) {
  const def = getWebSearch();
  return (await def.execute(
    {
      query: INPUT_QUERY,
      maxResults: null,
      searchDepth: null,
    },
    makeCtx(secrets),
  )) as { query: string; provider: string; results: any[]; error?: string };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("webSearch tool", () => {
  beforeEach(() => {
    mockTavilySearch.mockReset();
    auditLog.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Registration shape ────────────────────────────────────────────────

  it("registers exactly three RequiredSecretSpec fields (provider + 2 keys)", () => {
    const def = getWebSearch();
    expect(def.requiredSecrets).toBeDefined();
    expect(def.requiredSecrets).toHaveLength(3);

    const specs = def.requiredSecrets as readonly any[];
    const providerSpec = specs.find((s) => s.key === "search_provider");
    expect(providerSpec).toMatchObject({
      type: "select",
      choices: ["tavily", "serpapi", "duckduckgo"],
    });

    const tavilySpec = specs.find((s) => s.key === "tavily_api_key");
    expect(tavilySpec).toMatchObject({ type: "text", optional: true });

    const serpapiSpec = specs.find((s) => s.key === "serpapi_api_key");
    expect(serpapiSpec).toMatchObject({ type: "text", optional: true });
  });

  // ── Provider selection ────────────────────────────────────────────────

  describe("provider selection", () => {
    it("defaults to tavily when no search_provider is set (back-compat)", async () => {
      mockTavilySearch.mockResolvedValue({ results: [] });

      const out = await runWebSearch({ tavily_api_key: "sk-tav" });

      expect(out.provider).toBe("tavily");
      expect(mockTavilySearch).toHaveBeenCalledTimes(1);
    });

    it("uses tavily when search_provider='tavily'", async () => {
      mockTavilySearch.mockResolvedValue({ results: [] });

      const out = await runWebSearch({
        search_provider: "tavily",
        tavily_api_key: "sk-tav",
      });

      expect(out.provider).toBe("tavily");
      expect(mockTavilySearch).toHaveBeenCalledTimes(1);
    });

    it("uses serpapi when search_provider='serpapi'", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ organic_results: [] }), { status: 200 }),
      );

      const out = await runWebSearch({
        search_provider: "serpapi",
        serpapi_api_key: "sk-serp",
      });

      expect(out.provider).toBe("serpapi");
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/serpapi\.com\/search\?/),
        expect.any(Object),
      );
      expect(mockTavilySearch).not.toHaveBeenCalled();
    });

    it("uses duckduckgo when search_provider='duckduckgo' (no API key needed)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ Abstract: "", RelatedTopics: [] }), { status: 200 }),
      );

      const out = await runWebSearch({ search_provider: "duckduckgo" });

      expect(out.provider).toBe("duckduckgo");
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/api\.duckduckgo\.com\/\?/),
        expect.any(Object),
      );
      expect(mockTavilySearch).not.toHaveBeenCalled();
    });

    it("falls back to default provider for an unknown value", async () => {
      mockTavilySearch.mockResolvedValue({ results: [] });

      const out = await runWebSearch({
        search_provider: "bingerino",
        tavily_api_key: "sk-tav",
      });

      // 'bingerino' is unknown → resolveProvider returns DEFAULT (tavily)
      expect(out.provider).toBe("tavily");
      expect(mockTavilySearch).toHaveBeenCalled();
    });
  });

  // ── Tavily adapter ────────────────────────────────────────────────────

  describe("tavily adapter", () => {
    it("returns mapped results with title/url/content/score", async () => {
      mockTavilySearch.mockResolvedValue({
        results: [
          { title: "T1", url: "https://example.com/a", content: "snippet a", score: 0.9 },
          { title: "T2", url: "https://example.com/b", content: "snippet b", score: 0.7 },
        ],
      });

      const out = await runWebSearch({
        search_provider: "tavily",
        tavily_api_key: "sk-tav",
      });

      expect(out.error).toBeUndefined();
      expect(out.results).toEqual([
        { title: "T1", url: "https://example.com/a", content: "snippet a", score: 0.9 },
        { title: "T2", url: "https://example.com/b", content: "snippet b", score: 0.7 },
      ]);
    });

    it("returns an explicit error when tavily_api_key is missing", async () => {
      const out = await runWebSearch({ search_provider: "tavily" });

      expect(out.provider).toBe("tavily");
      expect(out.results).toEqual([]);
      expect(out.error).toMatch(/tavily_api_key/);
      expect(mockTavilySearch).not.toHaveBeenCalled();
    });
  });

  // ── SerpAPI adapter ───────────────────────────────────────────────────

  describe("serpapi adapter", () => {
    it("maps organic_results to the normalized shape", async () => {
      const payload = {
        organic_results: [
          { title: "S1", link: "https://example.com/x", snippet: "snip x" },
          { title: "S2", link: "https://example.com/y", snippet: "snip y" },
          // missing link → filtered out
          { title: "no-link" },
        ],
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );

      const out = await runWebSearch({
        search_provider: "serpapi",
        serpapi_api_key: "sk-serp",
      });

      expect(out.error).toBeUndefined();
      expect(out.results).toEqual([
        { title: "S1", url: "https://example.com/x", content: "snip x" },
        { title: "S2", url: "https://example.com/y", content: "snip y" },
      ]);
    });

    it("returns error when serpapi_api_key is missing", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const out = await runWebSearch({ search_provider: "serpapi" });

      expect(out.provider).toBe("serpapi");
      expect(out.results).toEqual([]);
      expect(out.error).toMatch(/serpapi_api_key/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("propagates SerpAPI error payload as a tool-level error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: "Invalid API key" }), { status: 200 }),
      );

      const out = await runWebSearch({
        search_provider: "serpapi",
        serpapi_api_key: "bad",
      });

      expect(out.results).toEqual([]);
      expect(out.error).toMatch(/Invalid API key/);
    });

    it("returns error on HTTP non-2xx", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("rate limit", { status: 429, statusText: "Too Many Requests" }),
      );

      const out = await runWebSearch({
        search_provider: "serpapi",
        serpapi_api_key: "sk-serp",
      });

      expect(out.results).toEqual([]);
      expect(out.error).toMatch(/HTTP 429/);
    });
  });

  // ── DuckDuckGo adapter ────────────────────────────────────────────────

  describe("duckduckgo adapter", () => {
    it("extracts Abstract + RelatedTopics into normalized results", async () => {
      const payload = {
        Heading: "Polyant",
        AbstractText: "A platform for AI assistants.",
        AbstractURL: "https://example.com/polyant",
        RelatedTopics: [
          { Text: "Topic A", FirstURL: "https://example.com/a" },
          { Text: "Topic B", FirstURL: "https://example.com/b" },
          { Topics: [/* nested group, ignored */] },
        ],
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );

      const out = await runWebSearch({ search_provider: "duckduckgo" });

      expect(out.error).toBeUndefined();
      expect(out.results.length).toBeGreaterThanOrEqual(2);
      const urls = out.results.map((r: any) => r.url);
      expect(urls).toContain("https://example.com/polyant");
      expect(urls).toContain("https://example.com/a");
      expect(urls).toContain("https://example.com/b");
    });

    it("returns empty results without error when DDG has no data", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ Abstract: "", RelatedTopics: [] }), { status: 200 }),
      );

      const out = await runWebSearch({ search_provider: "duckduckgo" });

      expect(out.error).toBeUndefined();
      expect(out.results).toEqual([]);
    });

    it("returns error on HTTP non-2xx from DDG", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("server error", { status: 500, statusText: "Internal Server Error" }),
      );

      const out = await runWebSearch({ search_provider: "duckduckgo" });

      expect(out.results).toEqual([]);
      expect(out.error).toMatch(/HTTP 500/);
    });
  });

  // ── Audit logging ─────────────────────────────────────────────────────

  it("logs the chosen provider in the audit entry", async () => {
    mockTavilySearch.mockResolvedValue({ results: [] });

    await runWebSearch({
      search_provider: "tavily",
      tavily_api_key: "sk-tav",
    });

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "web.search",
        success: true,
        details: expect.objectContaining({ provider: "tavily" }),
      }),
    );
  });

  it("marks the audit entry as failed when the provider returns an error", async () => {
    const out = await runWebSearch({ search_provider: "serpapi" }); // missing key

    expect(out.error).toBeDefined();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "web.search",
        success: false,
        details: expect.objectContaining({ provider: "serpapi" }),
      }),
    );
  });
});
