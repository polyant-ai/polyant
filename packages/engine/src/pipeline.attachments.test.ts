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
    clearContextPrompt: vi.fn(async () => undefined),
  },
}));
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: vi.fn(async () => undefined) }));
vi.mock("./memory/index.js", () => ({ extractMemories: vi.fn(async () => undefined) }));
// runPipelinePost runs the post-response hooks and records a trace first.
vi.mock("./hooks/hooks.store.js", () => ({ getEnabledHooks: vi.fn(async () => []) }));
vi.mock("./hooks/hook-registry.js", () => ({ getHookRegistry: vi.fn(() => new Map()) }));
vi.mock("./analytics/trace.store.js", () => ({ traceStore: { record: vi.fn() } }));
vi.mock("./hooks/hook-runner.js", () => ({
  runHooks: vi.fn(async () => []),
  firstHalt: vi.fn(),
  firstReplaceResponse: vi.fn(),
  firstRegenerate: vi.fn(),
  collectInjectContext: vi.fn(() => []),
  hookProvenance: vi.fn(() => undefined),
}));

import { afterResponse, runPipelinePost, type PipelineContext } from "./pipeline.js";
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

/**
 * Keeping the files a user sends is the agent's explicit choice. Before the
 * switch existed, configuring a bucket for the `fileUpload` tool was enough for
 * every inbound photo and document to be copied there, with nothing to say so.
 */
describe("runPipelinePost — attachment storage is opt-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadAttachment.mockResolvedValue({ type: "image", s3Key: "attachments/shop/c/a.jpg" });
  });

  function ctx(attachmentStorageEnabled: boolean): PipelineContext {
    return {
      pipelineStart: 0,
      instanceId: asInstanceSlug("shop"),
      conversationId: "shop:whatsapp:+39",
      conversationSummary: undefined,
      contextPrompt: undefined,
      channelIdentity: undefined,
      stateBuffer: undefined,
      history: undefined,
      isFirstTurn: true,
      hasOverflow: false,
      droppedMessages: undefined,
      instanceConfig: { attachmentStorageEnabled } as PipelineContext["instanceConfig"],
      langsmith: undefined,
      userAttachments: [{ type: "image", data: Buffer.from("jpeg"), mimeType: "image/jpeg" }],
      incomingSystemMessages: undefined,
      isAutoTaskTurn: false,
      inboundMetadata: undefined,
    };
  }

  const post = (c: PipelineContext) =>
    runPipelinePost({
      ctx: c,
      contextPrepMs: 1,
      messageText: "ecco la foto",
      channel: "whatsapp",
      resultText: "Ricevuta",
      usage: { promptTokens: 0, completionTokens: 0 },
      durationMs: 0,
      toolBuildingMs: 0,
      isStreaming: false,
    });

  it("does not upload an inbound attachment for an agent that has not opted in", async () => {
    await post(ctx(false));

    await vi.waitFor(() => expect(rolesWritten()).toEqual(["user", "assistant"]));
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  it("uploads it once the agent has opted in", async () => {
    await post(ctx(true));

    await vi.waitFor(() => expect(rolesWritten()).toEqual(["user", "assistant"]));
    expect(mockUploadAttachment).toHaveBeenCalledOnce();
  });
});
