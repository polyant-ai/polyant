// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/organizations/acme/workspaces/main/monitor",
  useSearchParams: () => new URLSearchParams(search),
}));

const list = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    monitor: { list: (params: unknown) => list(params), detail: vi.fn() },
    instances: { list: async () => ({ instances: [] }) },
  },
}));
vi.mock("@/lib/activity-stream/provider", () => ({ useActivityStreamContext: () => ({ events: [], realLive: true }) }));
vi.mock("@/lib/tenant/use-tenant-paths", () => ({ useTenantPaths: () => ({ workspace: (s: string) => s, org: () => "/" }) }));

import MonitorPage from "./page";

beforeEach(() => {
  replace.mockReset();
  list.mockReset();
  list.mockResolvedValue({
    items: [],
    nextCursor: null,
    types: [
      { type: "tool_call", group: "agents", retentionDays: 90 },
      { type: "webhook", group: "automations", retentionDays: null },
    ],
  });
});

describe("Monitor page", () => {
  it("reads its filters from the address, so the old tool-calls link opens narrowed", async () => {
    search = "group=agents&type=tool_call";
    renderWithProviders(<MonitorPage />);
    await screen.findByText("Nessun risultato");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ group: "agents", types: ["tool_call"] }));
  });

  it("ignores an outcome it does not offer", async () => {
    search = "outcome=exploded";
    renderWithProviders(<MonitorPage />);
    await screen.findByText("Ancora niente da mostrare");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ outcome: undefined }));
  });

  it("writes a chosen chip to the address, and drops it on «Tutto»", async () => {
    search = "";
    const user = userEvent.setup();
    renderWithProviders(<MonitorPage />);
    await screen.findByText("Ancora niente da mostrare");
    await user.click(screen.getByRole("tab", { name: "Automazioni" }));
    expect(replace).toHaveBeenLastCalledWith("/organizations/acme/workspaces/main/monitor?group=automations", { scroll: false });
  });
});
