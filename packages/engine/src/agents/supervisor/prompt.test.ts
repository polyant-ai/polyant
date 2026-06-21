// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tool } from "ai";
import type { PromptRow } from "../../instances/prompts.store.js";
import { asAgentUuid, asAgentSlug } from "../../instances/identifiers.js";

// ---------------------------------------------------------------------------
// Section content used across tests
// ---------------------------------------------------------------------------

const SECTION_CONTENT: Record<string, { title: string; content: string }> = {
  "01-identity": { title: "Identity", content: "# Identity\n\nYou are the Acme Corp assistant." },
  "02-soul": { title: "Soul", content: "# Personality\n\nProfessional yet friendly." },
  "03-tooling": { title: "Tooling", content: "# Available tools\n\n{{toolCatalog}}\n\n## Guidelines" },
  "04-safety": { title: "Safety", content: "# Rules and limits\n\nDon't make up information." },
  "05-skills": { title: "Skills", content: "# Skills (mandatory)\n\n{{skillsList}}" },
  "06-memory": { title: "Memory", content: "# Memory\n\nUse searchMemory proactively." },
  "07-user-identity": { title: "User Identity", content: "# User\n\nNo information available." },
  "08-datetime": { title: "Datetime", content: "# Date and Time\n\nCurrent date and time: {{datetime}}" },
};

function makePromptRows(agentId: string, overrides?: Partial<Record<string, string>>): PromptRow[] {
  return Object.entries(SECTION_CONTENT).map(([sectionKey, { title, content }]) => ({
    id: `row-${sectionKey}`,
    agentId: asAgentUuid(agentId),
    sectionKey,
    title,
    content: overrides?.[sectionKey] ?? content,
    updatedAt: new Date(),
  }));
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetPrompts = vi.fn<(id: string) => Promise<PromptRow[]>>();
const mockInvalidatePromptsCache = vi.fn();

vi.mock("../../instances/prompts.store.js", () => ({
  getPrompts: (...args: unknown[]) => mockGetPrompts(args[0] as string),
  invalidatePromptsCache: (...args: unknown[]) => mockInvalidatePromptsCache(args[0]),
}));

const mockDbSelect = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({
    innerJoin: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  }),
});

vi.mock("../../database/client.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

const mockHasAllRequiredEnvBatch = vi.fn<(slug: string, checks: unknown[]) => Promise<Map<string, boolean>>>();
vi.mock("../../instances/skill-env.store.js", () => ({
  hasAllRequiredEnvBatch: (...args: unknown[]) => mockHasAllRequiredEnvBatch(args[0] as string, args[1] as unknown[]),
}));

import {
  buildSupervisorSystemPrompt,
  normalizeRequiredEnv,
} from "./prompt.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_INSTANCE_ID = asAgentUuid("uuid-test-instance");
const TEST_INSTANCE_SLUG = asAgentSlug("test-instance");

function buildPrompt(overrides?: {
  tools?: Record<string, Tool>;
  agentId?: ReturnType<typeof asAgentUuid>;
  instanceSlug?: ReturnType<typeof asAgentSlug>;
  memoryEnabled?: boolean;
  conversationSummary?: string;
}) {
  return buildSupervisorSystemPrompt({
    agentId: overrides?.agentId ?? TEST_INSTANCE_ID,
    instanceSlug: overrides?.instanceSlug ?? TEST_INSTANCE_SLUG,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSupervisorSystemPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPrompts.mockResolvedValue(makePromptRows(TEST_INSTANCE_ID));
    // Default: no enabled skills
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });
    mockHasAllRequiredEnvBatch.mockResolvedValue(new Map());
  });

  it("includes all 8 sections separated by ---", async () => {
    const prompt = await buildPrompt();
    expect(prompt).toContain("# Identity");
    expect(prompt).toContain("# Personality");
    expect(prompt).toContain("# Available tools");
    expect(prompt).toContain("# Rules and limits");
    expect(prompt).toContain("# Skills (mandatory)");
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("# User");
    expect(prompt).toContain("# Date and Time");
    const separatorCount = (prompt.match(/\n\n---\n\n/g) ?? []).length;
    expect(separatorCount).toBe(7);
  });

  it("includes identity content", async () => {
    const prompt = await buildPrompt();
    expect(prompt).toContain("You are the Acme Corp assistant.");
  });

  it("includes soul content", async () => {
    const prompt = await buildPrompt();
    expect(prompt).toContain("Professional yet friendly.");
  });

  it("includes datetime with template replaced", async () => {
    const prompt = await buildPrompt();
    expect(prompt).not.toContain("{{datetime}}");
    expect(prompt).toContain("Current date and time:");
  });

  it("includes tool catalog when tools are provided", async () => {
    const tools: Record<string, Tool> = {
      searchMemory: { description: "Cerca nella memoria" } as Tool,
      webSearch: { description: "Ricerca web" } as Tool,
    };
    const prompt = await buildPrompt({ tools });
    expect(prompt).toContain("- **searchMemory**: Cerca nella memoria");
    expect(prompt).toContain("- **webSearch**: Ricerca web");
    expect(prompt).not.toContain("{{toolCatalog}}");
  });

  it("shows fallback text when no tools provided", async () => {
    const prompt = await buildPrompt();
    expect(prompt).toContain("No tools available.");
    expect(prompt).not.toContain("{{toolCatalog}}");
  });

  it("shows empty available_skills when no skills are enabled", async () => {
    const prompt = await buildPrompt();
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("No skills available");
    expect(prompt).not.toContain("{{skillsList}}");
  });

  it("does not include conversation context when no summary provided", async () => {
    const prompt = await buildPrompt();
    expect(prompt).not.toContain("Previous conversation context (summary)");
  });

  it("does not include channel identity section when channelIdentity is absent", async () => {
    const prompt = await buildPrompt();
    expect(prompt).not.toContain("## Current channel");
  });

  it("appends channel identity section when channelIdentity is provided (WhatsApp case)", async () => {
    const prompt = await buildSupervisorSystemPrompt({
      agentId: TEST_INSTANCE_ID,
      instanceSlug: TEST_INSTANCE_SLUG,
      channelIdentity: {
        channel: "whatsapp",
        channelId: "+390000000001",
        userName: "Paolo",
      },
    });
    expect(prompt).toContain("## Current channel");
    expect(prompt).toContain("You are talking via whatsapp.");
    expect(prompt).toContain("+390000000001");
    expect(prompt).toContain("Paolo");
    // CRM-specific guidance (e.g. HubSpot contact resolution hints) lives in
    // per-instance prompt sections, not in this code-injected block.
    expect(prompt).not.toContain("hubspot");
  });

  it("uses 'unknown' when userName is missing and lowercases the channel", async () => {
    const prompt = await buildSupervisorSystemPrompt({
      agentId: TEST_INSTANCE_ID,
      instanceSlug: TEST_INSTANCE_SLUG,
      channelIdentity: {
        channel: "Telegram",
        channelId: "123456789",
      },
    });
    expect(prompt).toContain("You are talking via telegram.");
    expect(prompt).toContain("- Channel ID: 123456789");
    expect(prompt).toContain("- User name: unknown");
  });

  it("appends conversation context section when conversationSummary is provided", async () => {
    const prompt = await buildPrompt({
      conversationSummary: "The user asked about the weather in Rome.",
    });
    expect(prompt).toContain("## Previous conversation context (summary)");
    expect(prompt).toContain("The user asked about the weather in Rome.");
    const separatorCount = (prompt.match(/\n\n---\n\n/g) ?? []).length;
    expect(separatorCount).toBe(8);
  });

  it("returns empty-filtered result when a section is missing from DB", async () => {
    // Return rows without 07-user-identity
    const rows = makePromptRows(TEST_INSTANCE_ID).filter(
      (r) => r.sectionKey !== "07-user-identity",
    );
    mockGetPrompts.mockResolvedValue(rows);

    const prompt = await buildPrompt();
    expect(prompt).toContain("# Identity");
    expect(prompt).toContain("# Memory");
    const separatorCount = (prompt.match(/\n\n---\n\n/g) ?? []).length;
    expect(separatorCount).toBe(6);
  });

  it("calls getPrompts with the instance UUID", async () => {
    const uuid = asAgentUuid("my-uuid");
    await buildPrompt({ agentId: uuid });
    expect(mockGetPrompts).toHaveBeenCalledWith(uuid);
  });

  it("excludes memory section when memoryEnabled is false", async () => {
    const prompt = await buildPrompt({ memoryEnabled: false });
    expect(prompt).not.toContain("# Memoria");
  });
});

describe("normalizeRequiredEnv", () => {
  it("returns empty array for non-array input", () => {
    expect(normalizeRequiredEnv(undefined)).toEqual([]);
    expect(normalizeRequiredEnv(null)).toEqual([]);
    expect(normalizeRequiredEnv("string")).toEqual([]);
    expect(normalizeRequiredEnv(42)).toEqual([]);
  });

  it("normalizes string items with sensitive defaulting to true", () => {
    const result = normalizeRequiredEnv(["API_KEY", "SECRET"]);
    expect(result).toEqual([
      { name: "API_KEY", sensitive: true },
      { name: "SECRET", sensitive: true },
    ]);
  });

  it("normalizes object items preserving description and sensitive", () => {
    const result = normalizeRequiredEnv([
      { name: "OPENWEATHER_API_KEY", description: "API key for OpenWeatherMap", sensitive: true },
      { name: "RESULT_LANG", description: "Result language", sensitive: false },
    ]);
    expect(result).toEqual([
      { name: "OPENWEATHER_API_KEY", description: "API key for OpenWeatherMap", sensitive: true },
      { name: "RESULT_LANG", description: "Result language", sensitive: false },
    ]);
  });

  it("defaults sensitive to true when not explicitly false", () => {
    const result = normalizeRequiredEnv([
      { name: "KEY_A" },
      { name: "KEY_B", sensitive: true },
      { name: "KEY_C", sensitive: false },
    ]);
    expect(result[0].sensitive).toBe(true);
    expect(result[1].sensitive).toBe(true);
    expect(result[2].sensitive).toBe(false);
  });

  it("handles mixed string and object items", () => {
    const result = normalizeRequiredEnv([
      "SIMPLE_KEY",
      { name: "COMPLEX_KEY", description: "Has description", sensitive: false },
    ]);
    expect(result).toEqual([
      { name: "SIMPLE_KEY", sensitive: true },
      { name: "COMPLEX_KEY", description: "Has description", sensitive: false },
    ]);
  });

  it("filters out invalid items", () => {
    const result = normalizeRequiredEnv([
      "VALID_KEY",
      42,
      null,
      { noName: true },
      { name: "ALSO_VALID" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("VALID_KEY");
    expect(result[1].name).toBe("ALSO_VALID");
  });
});
