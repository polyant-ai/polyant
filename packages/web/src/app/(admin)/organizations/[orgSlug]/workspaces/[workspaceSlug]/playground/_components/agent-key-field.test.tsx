// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => key }),
}));

import { AgentKeyField } from "./agent-key-field";

describe("AgentKeyField", () => {
  it("hides the key until asked and reports typing", async () => {
    const onChange = vi.fn();
    render(<AgentKeyField value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText("playground.authKeyPlaceholder") as HTMLInputElement;
    expect(input.type).toBe("password");

    await userEvent.type(input, "k");
    expect(onChange).toHaveBeenCalledWith("k");

    await userEvent.click(screen.getByLabelText("playground.authKeyShow"));
    expect(input.type).toBe("text");
  });
});
