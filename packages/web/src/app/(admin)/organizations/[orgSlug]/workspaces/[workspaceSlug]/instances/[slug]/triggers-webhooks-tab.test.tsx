// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The event-source webhook URL is bearer-equivalent (its holder can inject
 * arbitrary events into the agent), so the list endpoint no longer carries
 * it — see the engine-side fix in `webhook-sources.controller.ts`. This file
 * pins the corresponding web behaviour: the URL is fetched on demand, one
 * source at a time, on first expand — never eagerly for the whole list.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockList, mockWebhookUrl, mockRotateToken, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockList: vi.fn(),
  mockWebhookUrl: vi.fn(),
  mockRotateToken: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    eventSources: {
      list: mockList,
      create: vi.fn(),
      update: mockUpdate,
      delete: mockDelete,
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

import { TriggersWebhooksTab } from "./triggers-webhooks-tab";

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

  it("fetches the webhook URL for a source only when its drawer is opened", async () => {
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

  it("does not refetch a webhook URL already revealed when closing and reopening the drawer", async () => {
    const user = userEvent.setup();
    render(<TriggersWebhooksTab slug="acme" />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText("Source 1")); // expand — fetches
    await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledTimes(1));

    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "common.cancel" })); // close
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByText("Source 1")); // open again — cached

    expect(mockWebhookUrl).toHaveBeenCalledTimes(1);
  });

  it("caches the rotated URL from the rotate response without an extra reveal fetch", async () => {
    const user = userEvent.setup();
    render(<TriggersWebhooksTab slug="acme" />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText("Source 1")); // open — reveals the current URL
    await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole("button", { name: "room.sources.rotateToken" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "room.sources.rotateToken" }));

    await waitFor(() =>
      expect(screen.getByText("https://engine.example/webhooks/new")).toBeDefined(),
    );
    // The rotate response already carries the fresh URL — no redundant GET.
    expect(mockWebhookUrl).toHaveBeenCalledTimes(1);
  });

  it("reports an error, not success, when copying the webhook URL is rejected", async () => {
    const { toast } = await import("sonner");
    const user = userEvent.setup();
    render(<TriggersWebhooksTab slug="acme" />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    await user.click(screen.getByText("Source 1"));
    await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledTimes(1));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });

    await user.click(await screen.findByRole("button", { name: "common.copy" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("common.copyFailed"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("finds a source by name or by one of its definitions", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue([
      SOURCE,
      { ...SOURCE, id: "src-2", name: "Billing hook", definitions: [{ id: "d1", name: "Invoice paid", action: "backlog", enabled: true, matchingPrompt: "", interpretationPrompt: "", contextPrompt: null, outboundChannel: null, outboundTarget: null }] },
    ]);
    render(<TriggersWebhooksTab slug="acme" />);
    await screen.findByText("Source 1");

    await user.type(screen.getByRole("searchbox"), "invoice");

    expect(screen.getByText("Billing hook")).toBeInTheDocument();
    expect(screen.queryByText("Source 1")).not.toBeInTheDocument();
  });

  it("switches a source from its row without opening it, and takes the switch back when refused", async () => {
    const user = userEvent.setup();
    mockUpdate.mockRejectedValue(new Error("refused"));
    render(<TriggersWebhooksTab slug="acme" />);
    const sw = await screen.findByRole("switch", { name: "common.activeNamed" });
    expect(sw).toBeChecked();

    await user.click(sw);

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("acme", "src-1", { enabled: false }));
    await waitFor(() => expect(sw).toBeChecked());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deletes a source only from its drawer and only after confirming", async () => {
    const user = userEvent.setup();
    mockDelete.mockResolvedValue(undefined);
    render(<TriggersWebhooksTab slug="acme" />);
    await screen.findByText("Source 1");
    expect(screen.queryByRole("button", { name: "common.delete" })).not.toBeInTheDocument();

    await user.click(screen.getByText("Source 1"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "common.delete" }));
    expect(mockDelete).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "common.delete" }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("acme", "src-1"));
  });
});
