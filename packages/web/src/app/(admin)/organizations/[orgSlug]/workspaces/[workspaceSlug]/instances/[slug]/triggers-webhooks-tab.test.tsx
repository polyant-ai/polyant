// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The event-source webhook URL is bearer-equivalent (its holder can inject
 * arbitrary events into the agent), so the list endpoint no longer carries
 * it — see the engine-side fix in `webhook-sources.controller.ts`. This file
 * pins the corresponding web behaviour: the URL is fetched on demand, one
 * source at a time, on first expand — never eagerly for the whole list.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockList, mockWebhookUrl, mockRotateToken } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockWebhookUrl: vi.fn(),
  mockRotateToken: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    eventSources: {
      list: mockList,
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateToken: mockRotateToken,
      webhookUrl: mockWebhookUrl,
      listDefinitions: vi.fn(),
      createDefinition: vi.fn(),
      updateDefinition: vi.fn(),
      deleteDefinition: vi.fn(),
    },
  },
  getUserErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TriggersWebhooksTab } from "./triggers-webhooks-tab.js";

/** Shape of a list-endpoint row, deliberately without webhookUrl/webhookToken. */
const SOURCE = {
  id: "src-1",
  name: "Source 1",
  sourceType: "webhook",
  enabled: true,
  config: {},
  definitions: [],
};

describe("TriggersWebhooksTab — webhook URL reveal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([SOURCE]);
    mockWebhookUrl.mockResolvedValue({ webhookUrl: "https://engine.example/webhooks/abc123" });
    mockRotateToken.mockResolvedValue({ webhookToken: "new-token", webhookUrl: "https://engine.example/webhooks/new" });
  });

  it("does not fetch any webhook URL on initial load (no bulk credential pull)", async () => {
    render(<TriggersWebhooksTab slug="acme" />);

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    expect(mockWebhookUrl).not.toHaveBeenCalled();
  });

  it("fetches the webhook URL for a source only when it is expanded", async () => {
    const user = userEvent.setup();
    render(<TriggersWebhooksTab slug="acme" />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText("Source 1"));

    await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledWith("acme", "src-1"));
    expect(mockWebhookUrl).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText("https://engine.example/webhooks/abc123")).toBeDefined(),
    );
  });

  it("does not refetch a webhook URL already revealed when collapsing and re-expanding", async () => {
    const user = userEvent.setup();
    render(<TriggersWebhooksTab slug="acme" />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText("Source 1")); // expand — fetches
    await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText("Source 1")); // collapse
    await user.click(screen.getByText("Source 1")); // expand again — cached

    expect(mockWebhookUrl).toHaveBeenCalledTimes(1);
  });

  it("caches the rotated URL from the rotate response without an extra reveal fetch", async () => {
    const user = userEvent.setup();
    const { container } = render(<TriggersWebhooksTab slug="acme" />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText("Source 1")); // expand — reveals the current URL
    await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledTimes(1));

    // The rotate trigger is an icon-only button (no accessible name), so it
    // is located by its icon rather than by role name.
    const rotateTrigger = container.querySelector(".lucide-rotate-ccw")?.closest("button");
    expect(rotateTrigger).not.toBeNull();
    await user.click(rotateTrigger as HTMLElement);
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(screen.getByText("https://engine.example/webhooks/new")).toBeDefined(),
    );
    // The rotate response already carries the fresh URL — no redundant GET.
    expect(mockWebhookUrl).toHaveBeenCalledTimes(1);
  });
});
