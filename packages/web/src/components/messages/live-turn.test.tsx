// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveTurn } from "./live-turn";
import type { FeedEvent } from "@/lib/activity-stream/types";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "it", setLocale: vi.fn(), t: (key: string) => key }),
}));

const at = "2026-09-27T10:00:00.000Z";
const inbound: FeedEvent = { id: "in", ts: at, persona: "agent", category: "inbound", text: "whatsapp: ciao", responsePreview: "ciao" };
const tool: FeedEvent = { id: "tool", ts: at, persona: "agent", text: "searchKnowledge", tool: { name: "searchKnowledge", summary: "" }, status: "success" };
const thinking: FeedEvent = { id: "think", ts: at, persona: "thinking", text: "valuto", responsePreview: "valuto" };
const reply: FeedEvent = { id: "reply", ts: at, persona: "agent", text: "eccomi", responsePreview: "eccomi" };
const memory: FeedEvent = { id: "mem", ts: at, persona: "agent", category: "memory", text: "2 memorie" };

describe("LiveTurn", () => {
  it("shows the incoming message, the activity and a working indicator until the reply arrives", () => {
    render(<LiveTurn events={[inbound, thinking, tool]} showActivity />);

    expect(screen.getByText("ciao")).toBeInTheDocument();
    expect(screen.getByText("searchKnowledge")).toBeInTheDocument();
    expect(screen.getByText("message.reasoning.label")).toBeInTheDocument();
    expect(screen.getByLabelText("conversations.detail.liveWorking")).toBeInTheDocument();
  });

  it("drops the working indicator once the reply is in", () => {
    render(<LiveTurn events={[inbound, reply]} showActivity />);

    expect(screen.getByText("eccomi")).toBeInTheDocument();
    expect(screen.queryByLabelText("conversations.detail.liveWorking")).not.toBeInTheDocument();
  });

  it("keeps messages but hides activity rows when activity is off", () => {
    render(<LiveTurn events={[inbound, tool]} showActivity={false} />);

    expect(screen.getByText("ciao")).toBeInTheDocument();
    expect(screen.queryByText("searchKnowledge")).not.toBeInTheDocument();
  });

  it("shows a tool that has started but not finished as running", () => {
    const running: FeedEvent = { ...tool, id: "tool:c:1:start", status: undefined };
    render(<LiveTurn events={[inbound, running]} showActivity />);

    expect(screen.getByLabelText("message.activity.running")).toBeInTheDocument();
    expect(screen.queryByLabelText("message.activity.succeeded")).not.toBeInTheDocument();
  });

  it("renders nothing for events outside a turn, so a late memory event does not look like a turn in progress", () => {
    const { container } = render(<LiveTurn events={[memory]} showActivity />);

    expect(container).toBeEmptyDOMElement();
  });
});
