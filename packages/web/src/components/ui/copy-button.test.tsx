// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CopyButton } from "./copy-button";

vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe("CopyButton", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("copies the value and reports it through onCopied", async () => {
    const onCopied = vi.fn();
    render(<CopyButton value="secret" onCopied={onCopied} />);
    await userEvent.click(screen.getByRole("button", { name: "common.copy" }));
    expect(writeText).toHaveBeenCalledWith("secret");
    expect(onCopied).toHaveBeenCalledOnce();
  });

  it("shows its own failure message and skips onCopied when the clipboard refuses", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const onCopied = vi.fn();
    render(<CopyButton value="x" errorMessage="nope" onCopied={onCopied} />);
    await userEvent.click(screen.getByRole("button"));
    expect(toast.error).toHaveBeenCalledWith("nope");
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("writes the copied label after a copy in the labelled form", async () => {
    render(<CopyButton value="x" copiedLabel="Done" />);
    await userEvent.click(screen.getByRole("button", { name: "common.copy" }));
    expect(await screen.findByText("Done")).toBeInTheDocument();
  });
});
