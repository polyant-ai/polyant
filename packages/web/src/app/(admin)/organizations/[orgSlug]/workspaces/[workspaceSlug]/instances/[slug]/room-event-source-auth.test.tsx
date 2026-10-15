// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockSuccess, mockError } = vi.hoisted(() => ({ mockSuccess: vi.fn(), mockError: vi.fn() }));

vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("sonner", () => ({ toast: { success: mockSuccess, error: mockError } }));

import { WebhookAuthSection } from "./room-event-source-auth";

describe("WebhookAuthSection copy", () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderEditing(user: ReturnType<typeof userEvent.setup>) {
    render(<WebhookAuthSection currentMasked="" onSave={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[0]);
    await user.click(screen.getByText("room.sources.authGenerate").closest("button")!);
    return document.querySelector("svg.lucide-copy")!.closest("button")!;
  }

  it("reports an error, not success, when the clipboard write is rejected", async () => {
    const user = userEvent.setup();
    const copy = await renderEditing(user);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    await user.click(copy);
    expect(mockError).toHaveBeenCalledWith("common.copyFailed");
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it("reports success once the clipboard write resolves", async () => {
    const user = userEvent.setup();
    const copy = await renderEditing(user);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(copy);
    expect(writeText).toHaveBeenCalled();
    expect(mockSuccess).toHaveBeenCalledWith("room.sources.authCopied");
  });
});
