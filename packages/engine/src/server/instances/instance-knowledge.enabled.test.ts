// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

const { setDocumentEnabled } = vi.hoisted(() => ({ setDocumentEnabled: vi.fn() }));
vi.mock("../../knowledge/index.js", () => ({ setDocumentEnabled }));
vi.mock("../../knowledge/ingestion.js", () => ({ processDocument: vi.fn() }));
vi.mock("../../knowledge/doc-cap.js", () => ({ resolveKnowledgeDocCap: vi.fn() }));
vi.mock("./instance-helpers.js", () => ({ findInstanceOrFail: async (slug: string) => ({ slug }) }));
vi.mock("../utils/require-embedding-context.js", () => ({ requireEmbeddingContext: vi.fn() }));

import { InstanceKnowledgeController } from "./instance-knowledge.controller.js";

describe("PATCH /api/instances/:slug/knowledge/:docId", () => {
  const controller = new InstanceKnowledgeController();

  it("switches the document of that agent and answers with the new state", async () => {
    setDocumentEnabled.mockResolvedValue(true);
    await expect(controller.setEnabled("a1", "d1", { enabled: false })).resolves.toEqual({ id: "d1", enabled: false });
    expect(setDocumentEnabled).toHaveBeenCalledWith("d1", "a1", false);
  });

  it("answers 404 for a document that is not this agent's", async () => {
    setDocumentEnabled.mockResolvedValue(false);
    await expect(controller.setEnabled("a1", "nope", { enabled: true })).rejects.toMatchObject({ status: 404 });
  });

  it.each([[{}], [{ enabled: "yes" }], [undefined]])("refuses a body without a boolean (%j) with 400", async (body) => {
    setDocumentEnabled.mockClear();
    await expect(controller.setEnabled("a1", "d1", body as never)).rejects.toMatchObject({ status: 400 });
    expect(setDocumentEnabled).not.toHaveBeenCalled();
  });
});
