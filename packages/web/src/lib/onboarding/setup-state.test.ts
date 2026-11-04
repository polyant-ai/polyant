// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The «knowledge» step only needs to know that some document exists, so it
 * reads one row per agent instead of a whole page of documents.
 */

const h = vi.hoisted(() => ({ knowledgeList: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: {
    instances: { list: async () => ({ instances: [{ slug: "a1", provider: "openai", model: "m" }] }) },
    secrets: { list: async () => ({ secrets: [] }) },
    channels: { list: async () => ({ channels: [] }) },
    knowledge: { list: h.knowledgeList },
    conversations: { list: async () => ({ total: 0 }) },
  },
}));

import { loadSetupFacts } from "./setup-state";

describe("loadSetupFacts — knowledge", () => {
  beforeEach(() => h.knowledgeList.mockReset());

  it("reads one row and takes the count from the engine", async () => {
    h.knowledgeList.mockResolvedValue({ documents: [{ id: "d1" }], nextOffset: 1, total: 40, failed: 0 });

    expect((await loadSetupFacts()).knowledge).toBe(true);
    expect(h.knowledgeList).toHaveBeenCalledWith("a1", { limit: 1 });
  });

  it("is open while no agent has a document", async () => {
    h.knowledgeList.mockResolvedValue({ documents: [], nextOffset: null, total: 0, failed: 0 });

    expect((await loadSetupFacts()).knowledge).toBe(false);
  });
});
