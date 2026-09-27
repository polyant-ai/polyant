// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An inbound attachment is stored in the agent's bucket as part of persisting
 * the turn. When that upload failed — a bucket policy scoped to another prefix,
 * a wrong region, revoked credentials, a transient S3 error — the whole
 * persistence step threw: the user's message and the reply the contact had
 * already received were missing from the conversation, and the next turn ran
 * without them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUploadAttachment, mockAppendMessages } = vi.hoisted(() => ({
  mockUploadAttachment: vi.fn(),
  mockAppendMessages: vi.fn(async (_conversationId: string, _rows: unknown[]) => undefined),
}));

vi.mock("./attachments/agent-storage.js", () => ({ uploadAttachment: mockUploadAttachment }));
vi.mock("./conversations/index.js", () => ({
  conversationStore: {
    appendMessages: mockAppendMessages,
    getSystemMessageContents: vi.fn(async () => new Set<string>()),
    updateSummary: vi.fn(async () => undefined),
    updateTitle: vi.fn(async () => undefined),
    getConversation: vi.fn(async () => null),
    getTitle: vi.fn(async () => "t"),
  },
}));
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: vi.fn(async () => undefined) }));
vi.mock("./memory/index.js", () => ({ extractMemories: vi.fn(async () => undefined) }));

import { afterResponse } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";

function respond(attachments: { data: Buffer; mimeType: string }[]) {
  afterResponse({
    conversationId: "shop:whatsapp:+39",
    instanceId: asInstanceSlug("shop"),
    userMessage: "ecco la foto",
    assistantResponse: "Ricevuta, grazie",
    userAttachments: attachments.map((a) => ({ type: "image" as const, ...a })),
  });
}

const rolesWritten = () => mockAppendMessages.mock.calls.flatMap(([, rows]) => (rows as { role: string }[]).map((r) => r.role));

describe("afterResponse — attachment storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("persists the turn without the attachment when its upload fails", async () => {
    mockUploadAttachment.mockRejectedValue(Object.assign(new Error("denied on attachments/shop/shop:whatsapp:+39/a.jpg"), { name: "AccessDenied" }));

    respond([{ data: Buffer.from("jpeg"), mimeType: "image/jpeg" }]);

    await vi.waitFor(() => expect(rolesWritten()).toEqual(["user", "assistant"]));
    const [, [userRow]] = mockAppendMessages.mock.calls[0] as [string, { attachments?: unknown }[]];
    expect(userRow.attachments).toBeUndefined();
  });

  it("keeps the attachments that did upload when another one fails", async () => {
    const stored = { type: "image", mimeType: "image/png", s3Key: "attachments/shop/c/b.png", sizeBytes: 3 };
    mockUploadAttachment
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(stored);

    respond([
      { data: Buffer.from("jpeg"), mimeType: "image/jpeg" },
      { data: Buffer.from("png"), mimeType: "image/png" },
    ]);

    await vi.waitFor(() => expect(rolesWritten()).toEqual(["user", "assistant"]));
    const [, [userRow]] = mockAppendMessages.mock.calls[0] as [string, { attachments?: unknown }[]];
    expect(userRow.attachments).toEqual([stored]);
  });

  it("does not log the S3 message, which carries the conversation id", async () => {
    mockUploadAttachment.mockRejectedValue(Object.assign(new Error("denied on attachments/shop/shop:whatsapp:+39/a.jpg"), { name: "AccessDenied" }));

    respond([{ data: Buffer.from("jpeg"), mimeType: "image/jpeg" }]);

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("+39");
  });
});
