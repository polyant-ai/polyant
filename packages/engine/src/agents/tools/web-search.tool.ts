// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { tavily } from "@tavily/core";
import { registerTool, type ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";

const SUPPORTED_PROVIDERS = ["tavily", "serpapi", "duckduckgo"] as const;
type SearchProvider = (typeof SUPPORTED_PROVIDERS)[number];

const DEFAULT_PROVIDER: SearchProvider = "tavily";
const FETCH_TIMEOUT_MS = 10_000;

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface SearchInput {
  query: string;
  maxResults: number | null;
  searchDepth: "basic" | "advanced" | null;
}

interface ProviderOutput {
  results: SearchResult[];
  error?: string;
}

registerTool({
  name: "webSearch",
  description:
    "Search for up-to-date information on the web via a configurable search engine.\n" +
    "Use when information is not present in the knowledge base or memories: recent news, public data, technical documentation, market prices.\n" +
    "Do NOT use to search information already in the knowledge base — use searchKnowledge first.\n" +
    "Do NOT use to access specific URLs — use curl.\n" +
    "Returns title, URL, snippet, and (when available) a relevance score for each result.\n" +
    "The search backend is configured per-agent (Tavily, SerpAPI, or DuckDuckGo) — you do not choose it.\n" +
    "Caveat: searchDepth 'advanced' is slower but more accurate; 'basic' is sufficient for simple queries. Some providers ignore searchDepth.",
  category: "research",
  requiredSecrets: [
    {
      key: "search_provider",
      type: "select",
      choices: [...SUPPORTED_PROVIDERS],
      label: "Search provider",
      description:
        "Search backend used by webSearch for this agent. Tavily/SerpAPI need the matching API key; DuckDuckGo is free but limited (Instant Answers only).",
      optional: true,
    },
    {
      key: "tavily_api_key",
      type: "text",
      label: "Tavily API key",
      description: "Required only when the provider is 'tavily'.",
      optional: true,
    },
    {
      key: "serpapi_api_key",
      type: "text",
      label: "SerpAPI API key",
      description: "Required only when the provider is 'serpapi'.",
      optional: true,
    },
  ],
  inputExamples: [
    {
      label: "Deep search",
      input: { query: "GDPR regulation updates 2026", maxResults: 10, searchDepth: "advanced" },
    },
  ],
  create: (ctx: ToolContext) => ({
    parameters: z.object({
      query: z.string().describe("The search query"),
      maxResults: z
        .number()
        .nullable()
        .describe("Maximum number of results (default: 5). Pass null for default."),
      searchDepth: z
        .enum(["basic", "advanced"])
        .nullable()
        .describe("Search depth: 'basic' for fast results, 'advanced' for deep search. Pass null for default. Honored only by Tavily."),
    }),
    execute: async (input: SearchInput) => {
      const provider = resolveProvider(ctx.secrets?.search_provider);
      try {
        const { results, error } = await dispatchSearch(provider, ctx, input);
        ctx.audit.log({
          action: "web.search",
          details: {
            provider,
            query: auditPreview(input.query),
            resultCount: results.length,
            topDomains: topDomainsOf(results),
            ...(error ? { providerError: auditPreview(error) } : {}),
          },
          success: !error,
          ...(error ? { error } : {}),
        });
        return error
          ? { query: input.query, provider, results, error }
          : { query: input.query, provider, results };
      } catch (err) {
        const message = errMsg(err);
        console.error(`webSearch tool error (${provider}): ${message}`);
        ctx.audit.log({
          action: "web.search",
          details: { provider, query: auditPreview(input.query) },
          success: false,
          error: message,
        });
        return { query: input.query, provider, results: [], error: message };
      }
    },
  }),
});

function resolveProvider(raw: string | undefined): SearchProvider {
  if (!raw) return DEFAULT_PROVIDER;
  const normalized = raw.toLowerCase().trim();
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(normalized)
    ? (normalized as SearchProvider)
    : DEFAULT_PROVIDER;
}

function topDomainsOf(results: SearchResult[]): string[] {
  return results.slice(0, 5).map((r) => {
    try {
      return new URL(r.url).hostname;
    } catch {
      return r.url;
    }
  });
}

async function dispatchSearch(
  provider: SearchProvider,
  ctx: ToolContext,
  input: SearchInput,
): Promise<ProviderOutput> {
  switch (provider) {
    case "tavily":
      return searchTavily(ctx, input);
    case "serpapi":
      return searchSerpapi(ctx, input);
    case "duckduckgo":
      return searchDuckduckgo(input);
  }
}

async function searchTavily(ctx: ToolContext, input: SearchInput): Promise<ProviderOutput> {
  const apiKey = ctx.secrets?.tavily_api_key;
  if (!apiKey) {
    return {
      results: [],
      error: "Tavily provider selected but 'tavily_api_key' is not configured for this agent.",
    };
  }
  const client = tavily({ apiKey });
  const response = await client.search(input.query, {
    maxResults: input.maxResults ?? 5,
    searchDepth: input.searchDepth ?? "basic",
  });
  return {
    results: response.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    })),
  };
}

interface SerpapiResponse {
  organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
  error?: string;
}

async function searchSerpapi(ctx: ToolContext, input: SearchInput): Promise<ProviderOutput> {
  const apiKey = ctx.secrets?.serpapi_api_key;
  if (!apiKey) {
    return {
      results: [],
      error: "SerpAPI provider selected but 'serpapi_api_key' is not configured for this agent.",
    };
  }
  const params = new URLSearchParams({
    engine: "google",
    q: input.query,
    api_key: apiKey,
    num: String(input.maxResults ?? 5),
  });
  const res = await fetch(`https://serpapi.com/search?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    return { results: [], error: `SerpAPI HTTP ${res.status}: ${res.statusText}` };
  }
  const data = (await res.json()) as SerpapiResponse;
  if (data.error) {
    return { results: [], error: `SerpAPI error: ${data.error}` };
  }
  const organic = data.organic_results ?? [];
  return {
    results: organic
      .filter((r) => r.link && r.title)
      .map((r) => ({
        title: r.title ?? "",
        url: r.link ?? "",
        content: r.snippet ?? "",
      })),
  };
}

interface DuckduckgoResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>;
}

/**
 * DuckDuckGo Instant Answer API — free, no API key. Returns only curated "instant
 * answers" (Wikipedia infoboxes, disambiguations, calculators) — NOT a full web
 * search. Use only as a budget fallback; expect very limited result sets.
 */
async function searchDuckduckgo(input: SearchInput): Promise<ProviderOutput> {
  const params = new URLSearchParams({
    q: input.query,
    format: "json",
    no_html: "1",
    skip_disambig: "1",
  });
  const res = await fetch(`https://api.duckduckgo.com/?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    return { results: [], error: `DuckDuckGo HTTP ${res.status}: ${res.statusText}` };
  }
  const data = (await res.json()) as DuckduckgoResponse;
  const results: SearchResult[] = [];

  const abstractText = data.AbstractText ?? data.Abstract;
  if (abstractText && data.AbstractURL) {
    results.push({
      title: data.Heading ?? abstractText.slice(0, 80),
      url: data.AbstractURL,
      content: abstractText,
    });
  }

  for (const topic of data.RelatedTopics ?? []) {
    if (topic.FirstURL && topic.Text) {
      results.push({
        title: topic.Text.slice(0, 80),
        url: topic.FirstURL,
        content: topic.Text,
      });
    }
    if (results.length >= (input.maxResults ?? 5)) break;
  }

  return { results: results.slice(0, input.maxResults ?? 5) };
}
