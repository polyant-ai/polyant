// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/instances/config-resolver.ts
 *
 * Tests: resolveInstanceConfig (cache miss, cache hit, cache expired,
 * instance not found, instance found), invalidateInstanceConfigCache,
 * invalidateAllInstanceConfigCache.
 *
 * Uses vi.useFakeTimers() to control TTL behaviour.
 */

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockFindInstanceBySlug, mockGetAllSecretsById } = vi.hoisted(() => ({
  mockFindInstanceBySlug: vi.fn(),
  mockGetAllSecretsById: vi.fn(),
}));

vi.mock("./store.js", () => ({
  findInstanceBySlug: mockFindInstanceBySlug,
}));

vi.mock("./secrets.store.js", () => ({
  getAllSecretsById: mockGetAllSecretsById,
  SECRET_KEYS: {
    OPENAI_API_KEY: "openai_api_key",
    ANTHROPIC_API_KEY: "anthropic_api_key",
    AWS_ACCESS_KEY_ID: "aws_access_key_id",
    AWS_SECRET_ACCESS_KEY: "aws_secret_access_key",
    AWS_REGION: "aws_region",
    LANGSMITH_API_KEY: "langsmith_api_key",
    AUTH_API_KEY: "auth_api_key",
    TAVILY_API_KEY: "tavily_api_key",
    DEEPGRAM_API_KEY: "deepgram_api_key",
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import {
  resolveInstanceConfig,
  invalidateInstanceConfigCache,
  invalidateAllInstanceConfigCache,
} from "./config-resolver.js";
import { asInstanceSlug } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const fakeInstance = {
  id: "uuid-1",
  slug: "default",
  name: "Default Assistant",
  description: "A default assistant",
  status: "active",
  provider: "openai",
  model: "gpt-4o",
  memoryEnabled: true,
  knowledgeEnabled: false,
  langsmithEnabled: true,
  langsmithProject: "my-project",
  authEnabled: true,
  thinkingEnabled: false,
  stateInPromptEnabled: false,
  icon: null,
  sttProvider: "openai",
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

const fakeSecrets: Record<string, string> = {
  openai_api_key: "sk-openai-test",
  anthropic_api_key: "sk-anthropic-test",
  langsmith_api_key: "ls-key-test",
  auth_api_key: "auth-key-test",
  tavily_api_key: "tvly-key-test",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("instances/config-resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Clear internal cache between tests
    invalidateAllInstanceConfigCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Instance not found
  // -----------------------------------------------------------------------
  describe("when instance is not found", () => {
    it("returns a minimal config with safe defaults", async () => {
      mockFindInstanceBySlug.mockResolvedValue(undefined);

      const config = await resolveInstanceConfig(asInstanceSlug("nonexistent"));

      expect(config).toEqual({
        provider: undefined,
        model: undefined,
        apiKeys: {},
        secrets: {},
        langsmith: { enabled: false, project: null },
        authEnabled: false,
        memoryEnabled: false,
        knowledgeEnabled: false,
        thinkingEnabled: false,
        stateInPromptEnabled: false,
        stt: { provider: "openai", credentials: {} },
      });
      expect(mockFindInstanceBySlug).toHaveBeenCalledWith("nonexistent");
      expect(mockGetAllSecretsById).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Instance found — full config assembly
  // -----------------------------------------------------------------------
  describe("when instance is found", () => {
    it("assembles the full config from instance + secrets", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fakeInstance);
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      const config = await resolveInstanceConfig(asInstanceSlug("default"));

      expect(config).toEqual({
        provider: "openai",
        model: "gpt-4o",
        apiKeys: {
          openai: "sk-openai-test",
          anthropic: "sk-anthropic-test",
        },
        secrets: fakeSecrets,
        langsmith: {
          enabled: true,
          project: "my-project",
          apiKey: "ls-key-test",
        },
        authEnabled: true,
        authApiKey: "auth-key-test",
        memoryEnabled: true,
        knowledgeEnabled: false,
        // gpt-4o is not thinking-capable, so the gate keeps thinking off even
        // if the persisted preference were true. The fixture has it false.
        thinkingEnabled: false,
        stateInPromptEnabled: false,
        stt: {
          provider: "openai",
          credentials: { openai: { apiKey: "sk-openai-test" } },
        },
      });
      expect(mockFindInstanceBySlug).toHaveBeenCalledWith("default");
      expect(mockGetAllSecretsById).toHaveBeenCalledWith("uuid-1");
    });

    it("handles null provider and model gracefully", async () => {
      mockFindInstanceBySlug.mockResolvedValue({
        ...fakeInstance,
        provider: null,
        model: null,
      });
      mockGetAllSecretsById.mockResolvedValue({});

      const config = await resolveInstanceConfig(asInstanceSlug("default"));

      expect(config.provider).toBeUndefined();
      expect(config.model).toBeUndefined();
      expect(config.apiKeys).toEqual({
        openai: undefined,
        anthropic: undefined,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Cache miss → DB call
  // -----------------------------------------------------------------------
  describe("cache miss", () => {
    it("queries the database on first call", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fakeInstance);
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      await resolveInstanceConfig(asInstanceSlug("default"));

      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(1);
      expect(mockGetAllSecretsById).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cache hit (within TTL) → no DB call
  // -----------------------------------------------------------------------
  describe("cache hit (within TTL)", () => {
    it("returns cached config without hitting the database", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fakeInstance);
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      const first = await resolveInstanceConfig(asInstanceSlug("default"));

      // Advance time, but stay within the 30s TTL
      vi.advanceTimersByTime(15_000);

      const second = await resolveInstanceConfig(asInstanceSlug("default"));

      expect(first).toEqual(second);
      // DB should only be called once (the first call)
      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(1);
      expect(mockGetAllSecretsById).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cache expired (after TTL) → re-queries DB
  // -----------------------------------------------------------------------
  describe("cache expired (after TTL)", () => {
    it("re-queries the database after 30 seconds", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fakeInstance);
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      await resolveInstanceConfig(asInstanceSlug("default"));

      // Advance time past the 30s TTL
      vi.advanceTimersByTime(31_000);

      // Update mock to return different data
      const updatedSecrets = { ...fakeSecrets, openai_api_key: "sk-new-key" };
      mockGetAllSecretsById.mockResolvedValue(updatedSecrets);

      const config = await resolveInstanceConfig(asInstanceSlug("default"));

      expect(config.apiKeys.openai).toBe("sk-new-key");
      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(2);
      expect(mockGetAllSecretsById).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // invalidateInstanceConfigCache
  // -----------------------------------------------------------------------
  describe("invalidateInstanceConfigCache", () => {
    it("forces a re-query for the invalidated slug", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fakeInstance);
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      await resolveInstanceConfig(asInstanceSlug("default"));
      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(1);

      invalidateInstanceConfigCache(asInstanceSlug("default"));

      await resolveInstanceConfig(asInstanceSlug("default"));
      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(2);
    });

    it("does not affect other cached slugs", async () => {
      const otherInstance = { ...fakeInstance, id: "uuid-2", slug: "creative" };
      mockFindInstanceBySlug
        .mockResolvedValueOnce(fakeInstance)
        .mockResolvedValueOnce(otherInstance)
        .mockResolvedValueOnce(fakeInstance);
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      await resolveInstanceConfig(asInstanceSlug("default"));
      await resolveInstanceConfig(asInstanceSlug("creative"));

      invalidateInstanceConfigCache(asInstanceSlug("default"));

      // "creative" should still be cached
      await resolveInstanceConfig(asInstanceSlug("creative"));
      // "default" should re-query
      await resolveInstanceConfig(asInstanceSlug("default"));

      // findInstanceBySlug: 1 (default) + 1 (creative) + 1 (default re-query) = 3
      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(3);
    });
  });

  // -----------------------------------------------------------------------
  // invalidateAllInstanceConfigCache
  // -----------------------------------------------------------------------
  describe("invalidateAllInstanceConfigCache", () => {
    it("forces re-queries for all slugs", async () => {
      const otherInstance = { ...fakeInstance, id: "uuid-2", slug: "creative" };
      mockFindInstanceBySlug
        .mockResolvedValueOnce(fakeInstance)
        .mockResolvedValueOnce(otherInstance)
        .mockResolvedValueOnce(fakeInstance)
        .mockResolvedValueOnce(otherInstance);
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      await resolveInstanceConfig(asInstanceSlug("default"));
      await resolveInstanceConfig(asInstanceSlug("creative"));

      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(2);

      invalidateAllInstanceConfigCache();

      await resolveInstanceConfig(asInstanceSlug("default"));
      await resolveInstanceConfig(asInstanceSlug("creative"));

      // Both should re-query: 2 (initial) + 2 (after clear) = 4
      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(4);
    });
  });

  // -----------------------------------------------------------------------
  // Thinking gate (capability-gated runtime flag)
  // -----------------------------------------------------------------------
  describe("thinkingEnabled gate", () => {
    it("yields true when persisted preference and the model is capable", async () => {
      mockFindInstanceBySlug.mockResolvedValue({
        ...fakeInstance,
        slug: "thinking-on",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        thinkingEnabled: true,
      });
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      const config = await resolveInstanceConfig(asInstanceSlug("thinking-on"));
      expect(config.thinkingEnabled).toBe(true);
    });

    it("yields false when persisted preference is true but model is not capable", async () => {
      mockFindInstanceBySlug.mockResolvedValue({
        ...fakeInstance,
        slug: "thinking-stale",
        provider: "openai",
        model: "gpt-4o", // not thinking-capable
        thinkingEnabled: true,
      });
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      const config = await resolveInstanceConfig(asInstanceSlug("thinking-stale"));
      expect(config.thinkingEnabled).toBe(false);
    });

    it("yields false when persisted preference is false even on capable model", async () => {
      mockFindInstanceBySlug.mockResolvedValue({
        ...fakeInstance,
        slug: "thinking-off",
        provider: "openai",
        model: "o3",
        thinkingEnabled: false,
      });
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      const config = await resolveInstanceConfig(asInstanceSlug("thinking-off"));
      expect(config.thinkingEnabled).toBe(false);
    });

    it("falls back to the standard tier when model is null and gates by that", async () => {
      // Anthropic standard tier is claude-sonnet-4-5-20250929 → thinking-capable.
      mockFindInstanceBySlug.mockResolvedValue({
        ...fakeInstance,
        slug: "thinking-default-anthropic",
        provider: "anthropic",
        model: null,
        thinkingEnabled: true,
      });
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      const config = await resolveInstanceConfig(asInstanceSlug("thinking-default-anthropic"));
      expect(config.thinkingEnabled).toBe(true);
    });

    it("yields false when both provider and model are null", async () => {
      mockFindInstanceBySlug.mockResolvedValue({
        ...fakeInstance,
        slug: "thinking-no-model",
        provider: null,
        model: null,
        thinkingEnabled: true,
      });
      mockGetAllSecretsById.mockResolvedValue(fakeSecrets);

      const config = await resolveInstanceConfig(asInstanceSlug("thinking-no-model"));
      expect(config.thinkingEnabled).toBe(false);
    });
  });
});
