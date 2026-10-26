// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The attention box on an agent's Stato: the checks are listed, and the box folds
 * with the heading as its button, the choice remembered per reader.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusChecks } from "./status-checks-list";
import type { AgentCheck } from "./status-checks";
import type { StatusChecksState } from "./use-status-checks";

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "u1" } } }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/organizations/acme/workspaces/vendite/instances/a1",
}));
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

const KEY = "polyant:agent-attention-box:u1";

function check(): AgentCheck {
  return {
    id: "some-check",
    severity: "warning",
    titleKey: "status.check.noTools.title",
    bodyKey: "status.check.noTools.body",
    section: "tools",
    sectionKey: "instances.detail.tabTools",
  } as AgentCheck;
}

const renderBox = () =>
  render(
    <StatusChecks status={{ checks: [check()], verdict: "warning", loading: false, refresh: vi.fn() } as StatusChecksState} />,
  );

beforeEach(() => window.localStorage.clear());

describe("StatusChecks attention box", () => {
  it("is open by default and lists the check", () => {
    renderBox();
    expect(screen.getByRole("button", { name: /status.checks.attention/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("status.check.noTools.title")).toBeInTheDocument();
  });

  it("folds from its heading and stays folded on the next visit", async () => {
    const first = renderBox();
    await userEvent.setup().click(screen.getByRole("button", { name: /status.checks.attention/ }));

    // Catches a fold that comes back open at every reload.
    expect(screen.queryByText("status.check.noTools.title")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBe("closed");
    first.unmount();

    renderBox();
    expect(await screen.findByRole("button", { name: /status.checks.attention/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("status.check.noTools.title")).not.toBeInTheDocument();
  });

  it("still folds and opens when the browser has no storage", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderBox();
    await userEvent.setup().click(screen.getByRole("button", { name: /status.checks.attention/ }));
    expect(screen.queryByText("status.check.noTools.title")).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
