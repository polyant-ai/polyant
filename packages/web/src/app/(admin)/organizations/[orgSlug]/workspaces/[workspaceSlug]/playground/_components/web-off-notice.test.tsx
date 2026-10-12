// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => key }),
}));
vi.mock("@/lib/tenant/use-tenant-paths", () => ({
  useTenantPaths: () => ({ workspace: (sub: string) => `/organizations/o/workspaces/w${sub}` }),
}));

import { WebOffNotice } from "./web-off-notice";

describe("WebOffNotice", () => {
  it("says the Web channel is off and links to the agent's Channels section", () => {
    render(<WebOffNotice instanceSlug="shop" />);
    expect(screen.getByText(/playground.webOff$/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "playground.webOffLink" })).toHaveAttribute(
      "href",
      "/organizations/o/workspaces/w/instances/shop?tab=channels",
    );
  });
});
