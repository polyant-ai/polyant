// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Room and webhook turns run the same work after the reply as the pipeline.
 * They had their own copy of it, which already ran the title and the memory
 * extraction without the agent's LangSmith tracing, and outside the work that
 * shutdown waits for.
 */

import { describe, expect, it, vi } from "vitest";

const { mockTitle, mockExtract } = vi.hoisted(() => ({
  mockTitle: vi.fn(),
  mockExtract: vi.fn(async () => []),
}));

vi.mock("../utils/title-generator.js", () => ({ generateConversationTitle: mockTitle }));
vi.mock("../memory/index.js", () => ({ extractMemories: mockExtract }));
vi.mock("../memory/extractor.js", () => ({ extractMemories: mockExtract }));

import { postProcessDirectTurn } from "./direct-turn.js";
import { drainBackgroundTurns } from "../channels/background-turns.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import type { InstanceConfig } from "../instances/config-resolver.js";

describe("postProcessDirectTurn", () => {
  it("runs the title and the memory with the agent's tracing, as work shutdown waits for", async () => {
    let finishTitle!: () => void;
    mockTitle.mockImplementationOnce(() => new Promise<void>((resolve) => (finishTitle = resolve)));
    const instanceConfig = {
      provider: "openai",
      apiKeys: { openai: "sk-test" },
      memoryEnabled: true,
      langsmith: { enabled: true, apiKey: "ls-key", project: "rooms" },
    } as unknown as InstanceConfig;

    postProcessDirectTurn({
      conversationId: "room:agent:1",
      instanceSlug: asInstanceSlug("agent"),
      instanceConfig,
      titleContent: "Room cycle",
      titleContext: "This is a room conversation.",
    });

    expect(await drainBackgroundTurns(50)).toEqual({ pending: 1 });
    finishTitle();
    expect(await drainBackgroundTurns(1_000)).toEqual({ pending: 0 });
    const tracing = { apiKey: "ls-key", project: "rooms" };
    expect(mockTitle).toHaveBeenCalledWith(expect.objectContaining({ langsmith: tracing, context: "This is a room conversation." }));
    expect(mockExtract).toHaveBeenCalledWith("room:agent:1", "agent", { openai: "sk-test" }, "openai", tracing);
  });
});
