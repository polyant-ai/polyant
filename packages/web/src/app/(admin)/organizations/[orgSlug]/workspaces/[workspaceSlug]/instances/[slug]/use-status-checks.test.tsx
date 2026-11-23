// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The knowledge checks speak for every document of the agent, including the
 * ones past the first page of the list.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { makeInstance } from "@/test-fixtures/api";
import { makeKnowledgeDocument, makeKnowledgePage } from "@/test-fixtures/knowledge";

type Api = typeof import("@/lib/api").api;

const h = vi.hoisted(() => ({ knowledgeList: vi.fn<Api["knowledge"]["list"]>() }));

vi.mock("@/lib/api", () => ({
  api: {
    secrets: { list: (async () => ({ secrets: [] })) satisfies Api["secrets"]["list"] },
    channels: { list: (async () => ({ channels: [] })) satisfies Api["channels"]["list"] },
    knowledge: { list: h.knowledgeList },
    hooks: {
      list: (async () => ({ hooks: [] })) satisfies Api["hooks"]["list"],
      functions: (async () => ({ hookFunctions: [] })) satisfies Api["hooks"]["functions"],
    },
    room: { get: (async () => ({ configured: false })) satisfies Api["room"]["get"] },
    optouts: { list: (async () => ({ optouts: [], page: 1 })) satisfies Api["optouts"]["list"] },
  },
}));

import { useStatusChecks } from "./use-status-checks";

const agent = (knowledgeEnabled: boolean) =>
  makeInstance({ id: "i1", model: "m", knowledgeEnabled });

describe("useStatusChecks — knowledge", () => {
  beforeEach(() => {
    h.knowledgeList.mockReset();
    // An agent with many documents: the page holds one, the counts hold them all.
    h.knowledgeList.mockResolvedValue(
      makeKnowledgePage([makeKnowledgeDocument({ id: "d1", filename: "a.md" })], { nextOffset: 1, total: 700, failed: 3 }),
    );
  });

  it("counts the failed documents of the whole agent", async () => {
    const { result } = renderHook(() => useStatusChecks({ instance: agent(true), tools: [], skills: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.checks.find((c) => c.id === "knowledge-errors")?.params).toEqual({ count: 3 });
  });

  it("counts every unused document, not only the first page", async () => {
    const { result } = renderHook(() => useStatusChecks({ instance: agent(false), tools: [], skills: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.checks.find((c) => c.id === "knowledge-unused")?.params).toEqual({ count: 700 });
  });

  it("asks for a single row, since only the counts are read", async () => {
    const { result } = renderHook(() => useStatusChecks({ instance: agent(true), tools: [], skills: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(h.knowledgeList).toHaveBeenCalledWith("a1", { limit: 1 });
  });
});
