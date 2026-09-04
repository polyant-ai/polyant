// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The checks are rules, and this file is where the rules are argued with.
 *
 * `runStatusChecks` is pure for exactly this reason: each case here states a
 * configuration and the one thing the panel should say about it. What matters as
 * much as the positives are the NEGATIVES — a check that fires when it should not
 * is worse than one that never fires, because it teaches the reader to skip the
 * whole list.
 */

import { runStatusChecks, statusVerdict, type StatusCheckInput } from "./status-checks";
import type { Instance, ToolState } from "@/lib/api";

function agent(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "i1",
    slug: "a1",
    name: "A1",
    status: "active",
    provider: "openai",
    model: "gpt-5.6",
    authEnabled: true,
    a2aEnabled: false,
    debugEnabled: false,
    memoryEnabled: false,
    knowledgeEnabled: false,
    ...overrides,
  } as unknown as Instance;
}

/** Everything readable, everything in order: the baseline that must stay silent. */
function input(overrides: Partial<StatusCheckInput> = {}): StatusCheckInput {
  return {
    instance: agent(),
    tools: [{ name: "t1", description: "", category: "general", enabled: true } as ToolState],
    skills: [],
    secrets: [{ key: "openai_api_key", configured: true }],
    channels: [{ channelType: "telegram", enabled: true, config: { botToken: "x" } }],
    documents: [],
    hooks: [],
    hookFunctions: [],
    room: { configured: false },
    recentOptOuts: 0,
    optedOutCount: 0,
    ...overrides,
  } as StatusCheckInput;
}

const ids = (i: StatusCheckInput) => runStatusChecks(i).map((c) => c.id);

describe("runStatusChecks — a healthy agent", () => {
  it("says nothing at all", () => {
    expect(runStatusChecks(input())).toEqual([]);
  });

  it("reports ok when nothing fired", () => {
    expect(statusVerdict(runStatusChecks(input()))).toBe("ok");
  });
});

describe("runStatusChecks — silently broken", () => {
  /**
   * The check the catalogue was built around: `supervisor/index.ts` skips a tool
   * whose non-optional secret is unset, so the panel shows it enabled and the
   * model never sees it.
   */
  it("catches a tool whose required secret is missing", () => {
    const checks = runStatusChecks(
      input({
        tools: [
          {
            name: "web_search",
            description: "",
            category: "general",
            enabled: true,
            requiredSecrets: [{ key: "tavily_api_key", type: "text" }],
          } as ToolState,
        ],
        secrets: [{ key: "openai_api_key", configured: true }],
      }),
    );

    expect(checks[0].id).toBe("tools-missing-secrets");
    expect(checks[0].severity).toBe("broken");
    expect(checks[0].params?.names).toBe("web_search");
  });

  it("stays quiet when the secret IS configured", () => {
    expect(
      ids(
        input({
          tools: [
            {
              name: "web_search",
              description: "",
              category: "general",
              enabled: true,
              requiredSecrets: [{ key: "tavily_api_key", type: "text" }],
            } as ToolState,
          ],
          secrets: [{ key: "tavily_api_key", configured: true }],
        }),
      ),
    ).not.toContain("tools-missing-secrets");
  });

  /** An optional secret is optional: the tool still reaches the model. */
  it("ignores an optional secret", () => {
    expect(
      ids(
        input({
          tools: [
            {
              name: "http_request",
              description: "",
              category: "general",
              enabled: true,
              requiredSecrets: [{ key: "http_api_key", type: "text", optional: true }],
            } as ToolState,
          ],
          secrets: [{ key: "openai_api_key", configured: true }],
        }),
      ),
    ).not.toContain("tools-missing-secrets");
  });

  /** A disabled tool cannot fail to reach a model it was never going to reach. */
  it("ignores a disabled tool", () => {
    expect(
      ids(
        input({
          tools: [
            {
              name: "web_search",
              description: "",
              category: "general",
              enabled: false,
              requiredSecrets: [{ key: "tavily_api_key", type: "text" }],
            } as ToolState,
          ],
          secrets: [{ key: "openai_api_key", configured: true }],
        }),
      ),
    ).not.toContain("tools-missing-secrets");
  });

  /**
   * A viewer cannot read secrets. "Unknown" must not render as "missing", or the
   * page would accuse every agent of being broken for the wrong reader.
   */
  it("skips the secret checks entirely when secrets are unreadable", () => {
    expect(
      ids(
        input({
          secrets: null,
          tools: [
            {
              name: "web_search",
              description: "",
              category: "general",
              enabled: true,
              requiredSecrets: [{ key: "tavily_api_key", type: "text" }],
            } as ToolState,
          ],
        }),
      ),
    ).not.toContain("tools-missing-secrets");
  });

  it("catches retrieval switched on with no documents", () => {
    expect(ids(input({ instance: agent({ knowledgeEnabled: true }), documents: [] }))).toContain(
      "knowledge-empty",
    );
  });

  it("catches documents nobody searches", () => {
    expect(
      ids(
        input({
          instance: agent({ knowledgeEnabled: false }),
          documents: [{ id: "d1", status: "ready" }] as StatusCheckInput["documents"],
        }),
      ),
    ).toContain("knowledge-unused");
  });

  it("catches a hook pointing at a function that no longer exists", () => {
    expect(
      ids(
        input({
          hooks: [
            {
              id: "h1",
              event: "conversation_start",
              actionType: "function",
              actionConfig: { functionName: "gone" },
              enabled: true,
              position: 0,
              timeoutMs: 10000,
              createdAt: "",
              updatedAt: "",
            },
          ],
          hookFunctions: ["stillHere"],
        }),
      ),
    ).toContain("hooks-unknown-function");
  });

  it("catches a channel switched on without its credentials", () => {
    const checks = runStatusChecks(
      input({ channels: [{ channelType: "telegram", enabled: true, config: {} }] }),
    );
    expect(checks.map((c) => c.id)).toContain("channels-incomplete");
  });

  /** An inactive agent starts no channels — the cause of "it stopped answering". */
  it("catches an inactive agent with channels still on", () => {
    expect(ids(input({ instance: agent({ status: "inactive" }) }))).toContain(
      "inactive-with-channels",
    );
  });

  it("catches a room with nowhere to answer", () => {
    expect(
      ids(input({ room: { configured: true, enabled: true, prompt: "do things" } })),
    ).toContain("room-no-outbound");
  });

  it("says nothing about a room that is switched off", () => {
    expect(ids(input({ room: { configured: true, enabled: false } }))).toEqual([]);
  });
});

describe("runStatusChecks — exposed", () => {
  /**
   * Debug stores the full payload of every turn, PII included. A warning rather
   * than a break: it is a deliberate act during a hunt, and the failure is
   * leaving it on afterwards.
   */
  it("catches debug left on", () => {
    expect(ids(input({ instance: agent({ debugEnabled: true }) }))).toEqual(["debug-enabled"]);
  });

  /**
   * Both are breaks — an endpoint that answers as the agent and spends the budget
   * is not a "look at it later". A2A only changes WHICH row is shown: same cause,
   * worse consequence, and saying it twice would be the noise the list avoids.
   */
  it("names the A2A row instead of the API one when A2A is on", () => {
    const withA2a = runStatusChecks(
      input({ instance: agent({ authEnabled: false, a2aEnabled: true }) }),
    );
    expect(withA2a.map((c) => c.id)).toContain("a2a-open");
    expect(withA2a.map((c) => c.id)).not.toContain("api-open");
    expect(withA2a.find((c) => c.id === "a2a-open")?.severity).toBe("broken");

    const withoutA2a = runStatusChecks(input({ instance: agent({ authEnabled: false }) }));
    expect(withoutA2a.map((c) => c.id)).toContain("api-open");
    expect(withoutA2a.find((c) => c.id === "api-open")?.severity).toBe("broken");
  });

  it("counts only the opt-outs of the last week, above the threshold", () => {
    expect(ids(input({ recentOptOuts: 4 }))).not.toContain("opt-outs-rising");
    expect(ids(input({ recentOptOuts: 5 }))).toContain("opt-outs-rising");
  });

});

describe("runStatusChecks — the provider key", () => {
  it("catches a chat provider with no key anywhere", () => {
    const checks = runStatusChecks(
      input({ instance: agent({ provider: "anthropic" }), secrets: [] }),
    );

    const found = checks.find((c) => c.id === "provider-no-credentials");
    expect(found?.severity).toBe("broken");
    expect(found?.params?.provider).toBe("anthropic");
  });

  /**
   * Bedrock authenticates through the host's AWS profile or IAM role when no key
   * is set, so "no key" is a working configuration and an alert would be a false
   * alarm — the one provider deliberately outside this check.
   */
  it("says nothing about bedrock, which can run without a key", () => {
    expect(
      ids(input({ instance: agent({ provider: "bedrock" }), secrets: [] })),
    ).not.toContain("provider-no-credentials");
  });
});

describe("runStatusChecks — promises made to people", () => {
  /**
   * `evaluateOptout` returns `pass` without consulting the list when the switch is
   * off, so everyone who asked to be left alone is written to again.
   */
  it("catches opted-out contacts with the opt-out switched off", () => {
    const found = runStatusChecks(
      input({ instance: agent({ optoutEnabled: false }), optedOutCount: 12 }),
    ).find((c) => c.id === "optout-off-with-contacts");

    expect(found?.severity).toBe("broken");
    expect(found?.params?.count).toBe(12);
  });

  it("says nothing when the switch is on", () => {
    expect(
      ids(input({ instance: agent({ optoutEnabled: true }), optedOutCount: 12 })),
    ).not.toContain("optout-off-with-contacts");
  });

  it("says nothing when nobody opted out", () => {
    expect(
      ids(input({ instance: agent({ optoutEnabled: false }), optedOutCount: 0 })),
    ).not.toContain("optout-off-with-contacts");
  });
});

describe("runStatusChecks — skills", () => {
  it("catches a skill pinned below its current version", () => {
    expect(
      ids(
        input({
          skills: [
            { name: "faq", description: "", enabled: true, pinnedVersion: "2", currentVersion: "5" },
          ],
        }),
      ),
    ).toContain("skills-outdated-pin");
  });

  it("says nothing when the pin is the current version", () => {
    expect(
      ids(
        input({
          skills: [
            { name: "faq", description: "", enabled: true, pinnedVersion: "5", currentVersion: "5" },
          ],
        }),
      ),
    ).not.toContain("skills-outdated-pin");
  });

  it("catches a skill whose required tools are not served", () => {
    expect(
      ids(
        input({
          skills: [
            { name: "booking", description: "", enabled: true, requiredTools: ["bookAppointment"] },
          ],
        }),
      ),
    ).toContain("skills-missing-tools");
  });
});

describe("runStatusChecks — notes stay out of the verdict", () => {
  it("does not let a note make the agent look unhealthy", () => {
    const checks = runStatusChecks(
      input({
        tools: [{ name: "t", description: "", category: "g", enabled: false } as ToolState],
      }),
    );

    expect(checks.map((c) => c.id)).toContain("no-tools");
    expect(checks.every((c) => c.severity === "note")).toBe(true);
    expect(statusVerdict(checks)).toBe("ok");
  });

  it("puts the worst first", () => {
    const checks = runStatusChecks(
      input({
        instance: agent({ debugEnabled: true, status: "inactive" }),
        tools: [],
      }),
    );

    expect(checks[0].severity).toBe("broken");
    expect(checks[checks.length - 1].severity).toBe("note");
  });
});

describe("every check", () => {
  /**
   * Rule 1 of the catalogue: a check with nowhere to go is a complaint. Asserted
   * over a configuration that trips as many rules as possible at once.
   */
  it("has a destination and distinct ids", () => {
    const checks = runStatusChecks(
      input({
        instance: agent({
          status: "inactive",
          debugEnabled: true,
          authEnabled: false,
          a2aEnabled: true,
          knowledgeEnabled: true,
        }),
        tools: [],
        documents: [],
        recentOptOuts: 9,
        room: { configured: true, enabled: true },
      }),
    );

    expect(checks.length).toBeGreaterThan(5);
    for (const check of checks) {
      expect(check.section, check.id).toBeTruthy();
      expect(check.sectionKey, check.id).toBeTruthy();
    }
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
  });
});
