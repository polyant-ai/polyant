// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tool } from "ai";
import type { PromptRow } from "../../instances/prompts.store.js";
import { asInstanceUuid, asInstanceSlug } from "../../instances/identifiers.js";

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

function makePromptRows(instanceId: string, overrides?: Partial<Record<string, string>>): PromptRow[] {
  return Object.entries(SECTION_CONTENT).map(([sectionKey, { title, content }]) => ({
    id: `row-${sectionKey}`,
    instanceId: asInstanceUuid(instanceId),
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
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
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

const TEST_INSTANCE_ID = asInstanceUuid("uuid-test-instance");
const TEST_INSTANCE_SLUG = asInstanceSlug("test-instance");

function buildPrompt(overrides?: {
  tools?: Record<string, Tool>;
  instanceId?: ReturnType<typeof asInstanceUuid>;
  instanceSlug?: ReturnType<typeof asInstanceSlug>;
  memoryEnabled?: boolean;
  conversationSummary?: string;
  contextPrompt?: string;
}) {
  return buildSupervisorSystemPrompt({
    instanceId: overrides?.instanceId ?? TEST_INSTANCE_ID,
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
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    });
    mockHasAllRequiredEnvBatch.mockResolvedValue(new Map());
  });

  it("puts the 7 stable sections in `system` and the datetime in `turnContext`", async () => {
    const { system, turnContext } = await buildPrompt();
    expect(system).toContain("# Identity");
    expect(system).toContain("# Personality");
    expect(system).toContain("# Available tools");
    expect(system).toContain("# Rules and limits");
    expect(system).toContain("# Skills (mandatory)");
    expect(system).toContain("# Memory");
    expect(system).toContain("# User");
    // Datetime is volatile → it moves out of the cacheable system prefix.
    expect(system).not.toContain("# Date and Time");
    expect(turnContext).toContain("# Date and Time");
    // 7 stable sections → 6 separators.
    const separatorCount = (system.match(/\n\n---\n\n/g) ?? []).length;
    expect(separatorCount).toBe(6);
  });

  it("includes identity content in system", async () => {
    const { system } = await buildPrompt();
    expect(system).toContain("You are the Acme Corp assistant.");
  });

  it("includes soul content in system", async () => {
    const { system } = await buildPrompt();
    expect(system).toContain("Professional yet friendly.");
  });

  it("renders the datetime template into turnContext, not system", async () => {
    const { system, turnContext } = await buildPrompt();
    expect(turnContext).not.toContain("{{datetime}}");
    expect(turnContext).toContain("Current date and time:");
    expect(system).not.toContain("Current date and time:");
  });

  it("includes tool catalog in system when tools are provided", async () => {
    const tools: Record<string, Tool> = {
      searchMemory: { description: "Cerca nella memoria" } as Tool,
      webSearch: { description: "Ricerca web" } as Tool,
    };
    const { system } = await buildPrompt({ tools });
    expect(system).toContain("- **searchMemory**: Cerca nella memoria");
    expect(system).toContain("- **webSearch**: Ricerca web");
    expect(system).not.toContain("{{toolCatalog}}");
  });

  it("shows fallback text when no tools provided", async () => {
    const { system } = await buildPrompt();
    expect(system).toContain("No tools available.");
    expect(system).not.toContain("{{toolCatalog}}");
  });

  it("shows empty available_skills when no skills are enabled", async () => {
    const { system } = await buildPrompt();
    expect(system).toContain("<available_skills>");
    expect(system).toContain("No skills available");
    expect(system).not.toContain("{{skillsList}}");
  });

  it("does not include conversation summary anywhere when none provided", async () => {
    const { system, turnContext } = await buildPrompt();
    expect(system).not.toContain("Previous conversation context (summary)");
    expect(turnContext).not.toContain("Previous conversation context (summary)");
  });

  it("does not include channel identity section when channelIdentity is absent", async () => {
    const { turnContext } = await buildPrompt();
    expect(turnContext).not.toContain("## Current channel");
  });

  it("puts channel identity in turnContext when provided (WhatsApp case), never in system", async () => {
    const { system, turnContext } = await buildSupervisorSystemPrompt({
      instanceId: TEST_INSTANCE_ID,
      instanceSlug: TEST_INSTANCE_SLUG,
      channelIdentity: {
        channel: "whatsapp",
        channelId: "+390000000001",
        userName: "Paolo",
      },
    });
    expect(turnContext).toContain("## Current channel");
    expect(turnContext).toContain("You are talking via whatsapp.");
    expect(turnContext).toContain("+390000000001");
    expect(turnContext).toContain("Paolo");
    expect(system).not.toContain("## Current channel");
    // CRM-specific guidance (e.g. HubSpot contact resolution hints) lives in
    // per-instance prompt sections, not in this code-injected block.
    expect(turnContext).not.toContain("hubspot");
  });

  it("uses 'unknown' when userName is missing and lowercases the channel", async () => {
    const { turnContext } = await buildSupervisorSystemPrompt({
      instanceId: TEST_INSTANCE_ID,
      instanceSlug: TEST_INSTANCE_SLUG,
      channelIdentity: {
        channel: "Telegram",
        channelId: "123456789",
      },
    });
    expect(turnContext).toContain("You are talking via telegram.");
    expect(turnContext).toContain("- Channel ID: 123456789");
    expect(turnContext).toContain("- User name: unknown");
  });

  it("puts the conversation summary in turnContext when provided, never in system", async () => {
    const { system, turnContext } = await buildPrompt({
      conversationSummary: "The user asked about the weather in Rome.",
    });
    expect(turnContext).toContain("## Previous conversation context (summary)");
    expect(turnContext).toContain("The user asked about the weather in Rome.");
    expect(system).not.toContain("Previous conversation context (summary)");
  });

  it("keeps the persisted webhook contextPrompt in the cacheable system prefix", async () => {
    const { system, turnContext } = await buildPrompt({
      contextPrompt: "Triggered by webhook: order #42 shipped.",
    });
    expect(system).toContain("## Conversation Context");
    expect(system).toContain("order #42 shipped");
    expect(turnContext).not.toContain("Conversation Context");
  });

  it("keeps 6 separators in system when a section is missing from DB", async () => {
    // Return rows without 07-user-identity (and 08-datetime lives in turnContext)
    const rows = makePromptRows(TEST_INSTANCE_ID).filter(
      (r) => r.sectionKey !== "07-user-identity",
    );
    mockGetPrompts.mockResolvedValue(rows);

    const { system } = await buildPrompt();
    expect(system).toContain("# Identity");
    expect(system).toContain("# Memory");
    // 6 stable sections (07 dropped) → 5 separators.
    const separatorCount = (system.match(/\n\n---\n\n/g) ?? []).length;
    expect(separatorCount).toBe(5);
  });

  it("calls getPrompts with the instance UUID", async () => {
    const uuid = asInstanceUuid("my-uuid");
    await buildPrompt({ instanceId: uuid });
    expect(mockGetPrompts).toHaveBeenCalledWith(uuid);
  });

  it("excludes memory section when memoryEnabled is false", async () => {
    const { system } = await buildPrompt({ memoryEnabled: false });
    expect(system).not.toContain("# Memoria");
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
