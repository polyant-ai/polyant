// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InstancesPage from "./page";
import type { Instance } from "@/lib/api";

const { mockList, mockImportNew, mockPush, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockImportNew: vi.fn(),
  mockPush: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
  useParams: () => ({ orgSlug: "acme", workspaceSlug: "sales" }),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      instances: { list: (...args: unknown[]) => mockList(...args), create: vi.fn() },
      exportImport: { importNew: (...args: unknown[]) => mockImportNew(...args) },
    },
  };
});

function agent(over: Partial<Instance>): Instance {
  return {
    id: over.slug ?? "id",
    slug: "agent",
    name: "Agent",
    description: null,
    status: "active",
    icon: null,
    updatedAt: new Date().toISOString(),
    ...over,
  } as Instance;
}

const AGENTS = [
  agent({ id: "1", slug: "support-bot", name: "Support Bot" }),
  agent({ id: "2", slug: "old-bot", name: "Old Bot", status: "inactive" }),
];

beforeEach(() => {
  localStorage.clear();
});

describe("InstancesPage", () => {
  it("lists the active agents, linked inside the workspace, and hides inactive ones until asked", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ instances: AGENTS });
    render(<InstancesPage />);

    // The name is a real link, so open-in-new-tab and the address on hover work.
    const link = await screen.findByRole("link", { name: /Support Bot/ });
    expect(link).toHaveAttribute("href", "/organizations/acme/workspaces/sales/instances/support-bot");
    // A click elsewhere on the row goes to the same address.
    await user.click(screen.getByText("support-bot"));
    expect(mockPush).toHaveBeenCalledWith("/organizations/acme/workspaces/sales/instances/support-bot");
    expect(screen.queryByText("Old Bot")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /instances.filter.all/ }));

    expect(screen.getByRole("link", { name: /Old Bot/ })).toBeInTheDocument();
  });

  it("filters the rows by what is typed, on the name and the slug", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({
      instances: [...AGENTS, agent({ id: "3", slug: "billing", name: "Invoices", description: "Chases payments" })],
    });
    render(<InstancesPage />);
    await screen.findByRole("link", { name: /Support Bot/ });

    await user.type(screen.getByRole("searchbox"), "billing");

    expect(screen.getByRole("link", { name: /Invoices/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Support Bot/ })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("common.noResults")).toBeInTheDocument();
  });

  it("sorts the agents by name, whatever order the engine returns them in", async () => {
    mockList.mockResolvedValue({
      instances: [
        agent({ id: "1", slug: "z", name: "Zeta" }),
        agent({ id: "2", slug: "a", name: "alpha" }),
        agent({ id: "3", slug: "b", name: "Beta" }),
      ],
    });
    render(<InstancesPage />);
    await screen.findByRole("link", { name: /Zeta/ });

    const names = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("link")[0].textContent);
    expect(names).toEqual(["alpha", "Beta", "Zeta"]);
  });

  it("shows the description under the name as the row's summary", async () => {
    mockList.mockResolvedValue({ instances: [agent({ id: "1", slug: "s", name: "Support Bot", description: "Answers tickets" })] });
    render(<InstancesPage />);

    expect(await screen.findByText("Answers tickets")).toBeInTheDocument();
  });

  it("switches to cards that show the same agents, search and filter, each a real link, and remembers the choice", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ instances: AGENTS });
    const { unmount } = render(<InstancesPage />);
    await screen.findByRole("link", { name: /Support Bot/ });

    await user.click(screen.getByRole("button", { name: "instances.viewGrid" }));

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const card = screen.getByRole("link", { name: /Support Bot/ });
    expect(card).toHaveAttribute("href", "/organizations/acme/workspaces/sales/instances/support-bot");
    expect(screen.queryByText("Old Bot")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("common.noResults")).toBeInTheDocument();

    unmount();
    render(<InstancesPage />);
    await screen.findByRole("searchbox");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the description under the name on a card, clamped to two lines", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ instances: [agent({ id: "1", slug: "s", name: "Support Bot", description: "Answers tickets all day" })] });
    render(<InstancesPage />);
    await user.click(await screen.findByRole("button", { name: "instances.viewGrid" }));

    expect(screen.getByText("Answers tickets all day")).toHaveClass("line-clamp-2");
  });

  it("shows the empty state when the workspace has no agents", async () => {
    mockList.mockResolvedValue({ instances: [] });
    render(<InstancesPage />);

    expect(await screen.findByText("instances.empty.title")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("reports a failed load instead of showing an empty workspace silently", async () => {
    mockList.mockRejectedValue(new Error("network"));
    render(<InstancesPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("common.loadFailed");
    expect(screen.queryByText("instances.empty.title")).not.toBeInTheDocument();
  });

  it("imports a bundle as a new agent, shows its warnings and opens it", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ instances: AGENTS });
    mockImportNew.mockResolvedValue({
      slug: "imported-bot",
      instanceId: "9",
      warnings: [{ type: "secret", message: "Secret OPENAI_KEY was not exported" }],
    });
    const { container } = render(<InstancesPage />);
    await screen.findByRole("link", { name: /Support Bot/ });

    const bundle = { version: 1, instance: { slug: "imported-bot" } };
    const file = new File([JSON.stringify(bundle)], "bundle.json", { type: "application/json" });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/organizations/acme/workspaces/sales/instances/imported-bot"),
    );
    expect(mockImportNew).toHaveBeenCalledWith(bundle);
    // The list page unmounts on navigation, so importing does not re-read the list first.
    expect(mockList).toHaveBeenCalledTimes(1);
    const warnings = await screen.findByRole("dialog");
    expect(within(warnings).getByText("Secret OPENAI_KEY was not exported")).toBeInTheDocument();
  });

  it("rejects a file that is not JSON without calling the engine", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ instances: AGENTS });
    const { container } = render(<InstancesPage />);
    await screen.findByRole("link", { name: /Support Bot/ });

    const file = new File(["not json"], "bundle.json", { type: "application/json" });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("exportImport.import.failed"));
    expect(mockImportNew).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
