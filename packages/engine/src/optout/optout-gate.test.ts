// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getOptoutStatus,
  setOptoutStatus,
  resolveInstanceConfig,
  resolveInstanceId,
  ensureConversation,
  appendMessages,
  auditLog,
} = vi.hoisted(() => ({
  getOptoutStatus: vi.fn(),
  setOptoutStatus: vi.fn(),
  resolveInstanceConfig: vi.fn(),
  resolveInstanceId: vi.fn(),
  ensureConversation: vi.fn(),
  appendMessages: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("./contact-optouts.store.js", () => ({ getOptoutStatus, setOptoutStatus }));
vi.mock("../instances/config-resolver.js", () => ({ resolveInstanceConfig }));
vi.mock("../instances/resolve-instance-id.js", () => ({ resolveInstanceId }));
vi.mock("../conversations/index.js", () => ({ conversationStore: { ensureConversation, appendMessages } }));
vi.mock("../audit/audit-logger.js", () => ({ createAuditLogger: () => ({ log: auditLog }) }));

import { runOptoutGate } from "./optout-gate.js";
import type { IncomingMessage } from "../channels/types.js";

const baseMsg = (text: string): IncomingMessage => ({
  channelType: "whatsapp",
  channelId: "+39111",
  instanceId: "acme" as never,
  userName: "Mario",
  text,
  metadata: {},
});

const enabledConfig = {
  optout: { enabled: true, stopKeywords: ["STOP"], resumeKeywords: ["START"], closingMessage: "Bye.", resumeMessage: "Hi again.", injectPromptHint: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveInstanceConfig.mockResolvedValue(enabledConfig);
  resolveInstanceId.mockResolvedValue("uuid-1");
  ensureConversation.mockResolvedValue({ created: true });
  appendMessages.mockResolvedValue(undefined);
});

describe("runOptoutGate", () => {
  it("proceeds for synthetic channels without touching the store", async () => {
    const res = await runOptoutGate({ ...baseMsg("STOP"), channelType: "room" as never });
    expect(res).toEqual({ proceed: true });
    expect(resolveInstanceConfig).not.toHaveBeenCalled();
  });

  it("proceeds for auto-task messages", async () => {
    const res = await runOptoutGate(baseMsg("### Task:\nGenerate a title"));
    expect(res).toEqual({ proceed: true });
  });

  it("proceeds when the feature is disabled", async () => {
    resolveInstanceConfig.mockResolvedValue({ optout: { ...enabledConfig.optout, enabled: false } });
    const res = await runOptoutGate(baseMsg("STOP"));
    expect(res).toEqual({ proceed: true });
  });

  it("records opt-out and returns the closing message on STOP", async () => {
    getOptoutStatus.mockResolvedValue("opted_in");
    const res = await runOptoutGate(baseMsg("STOP"));
    expect(setOptoutStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "opted_out", source: "user", channelId: "+39111" }));
    expect(res).toEqual({ proceed: false, reply: "Bye." });
    expect(appendMessages).toHaveBeenCalled(); // exchange persisted
  });

  it("returns silence (empty reply) for a normal message while opted out", async () => {
    getOptoutStatus.mockResolvedValue("opted_out");
    const res = await runOptoutGate(baseMsg("are you there?"));
    expect(res).toEqual({ proceed: false, reply: "" });
    expect(setOptoutStatus).not.toHaveBeenCalled();
    expect(appendMessages).not.toHaveBeenCalled(); // silenced messages are not persisted
  });

  it("clears opt-out and returns the resume message on START", async () => {
    getOptoutStatus.mockResolvedValue("opted_out");
    const res = await runOptoutGate(baseMsg("START"));
    expect(setOptoutStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "opted_in", source: "user" }));
    expect(res).toEqual({ proceed: false, reply: "Hi again." });
  });
});
