// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The «knowledge» step only needs to know that some document exists, so it
 * reads one row per agent instead of a whole page of documents.
 */

import type { KnowledgeDocument } from "@/lib/api-types";
import { makeInstance } from "@/test-fixtures/api";
import { makeConversationList } from "@/test-fixtures/conversations";

const h = vi.hoisted(() => ({
  knowledgeList: vi.fn<typeof import("@/lib/api").api.knowledge.list>(),
  instancesList: vi.fn<typeof import("@/lib/api").api.instances.list>(),
  secretsList: vi.fn<typeof import("@/lib/api").api.secrets.list>(),
  channelsList: vi.fn<typeof import("@/lib/api").api.channels.list>(),
  conversationsList: vi.fn<typeof import("@/lib/api").api.conversations.list>(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    instances: { list: h.instancesList },
    secrets: { list: h.secretsList },
    channels: { list: h.channelsList },
    knowledge: { list: h.knowledgeList },
    conversations: { list: h.conversationsList },
  },
}));

const document: KnowledgeDocument = {
  id: "d1",
  filename: "faq.md",
  mimeType: "text/markdown",
  sizeBytes: 10,
  source: "upload",
  status: "ready",
  chunkCount: 1,
  errorMessage: null,
  enabled: true,
  createdAt: null,
  updatedAt: null,
};

import { loadSetupFacts } from "./setup-state";

describe("loadSetupFacts — knowledge", () => {
  beforeEach(() => {
    h.knowledgeList.mockReset();
    h.instancesList.mockResolvedValue({ instances: [makeInstance({ slug: "a1", provider: "openai", model: "m" })] });
    h.secretsList.mockResolvedValue({ secrets: [] });
    h.channelsList.mockResolvedValue({ channels: [] });
    h.conversationsList.mockResolvedValue(makeConversationList([]));
  });

  it("reads one row and takes the count from the engine", async () => {
    h.knowledgeList.mockResolvedValue({ documents: [document], nextOffset: 1, total: 40, failed: 0 });

    expect((await loadSetupFacts()).knowledge).toBe(true);
    expect(h.knowledgeList).toHaveBeenCalledWith("a1", { limit: 1 });
  });

  it("is open while no agent has a document", async () => {
    h.knowledgeList.mockResolvedValue({ documents: [], nextOffset: null, total: 0, failed: 0 });

    expect((await loadSetupFacts()).knowledge).toBe(false);
  });
});
