// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { agentConversationsSubpath } from "./from-agent";

describe("agentConversationsSubpath", () => {
  it("points at the agent's Conversations section, with the slug encoded", () => {
    expect(agentConversationsSubpath("sofia")).toBe("/instances/sofia?tab=conversations");
    expect(agentConversationsSubpath("a b")).toBe("/instances/a%20b?tab=conversations");
  });
});
