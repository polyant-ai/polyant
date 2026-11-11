// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InstancesPage from "./page";
import { ApiError, type Instance } from "@/lib/api";

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
      // The star on each row reads the person's favorites; none here.
      me: { favoriteAgents: () => Promise.resolve({ agentIds: [] }) },
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

  const BUNDLE = {
    version: "1.3",
    type: "instance",
    instance: {
      slug: "support-bot",
      name: "Support Bot",
      provider: "openai",
      model: "gpt-5",
      prompts: [{ sectionKey: "identity", title: "Identity", content: "" }],
      manualTools: ["search_kb", "send_email"],
      secrets: [{ key: "CRM_TOKEN", configured: true }],
      channels: [],
    },
  };

  async function chooseFile(container: HTMLElement, contents: string) {
    const file = new File([contents], "bundle.json", { type: "application/json" });
    await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);
  }

  it("shows what the file brings before importing, under the name and slug confirmed", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ instances: AGENTS });
    mockImportNew.mockResolvedValue({
      slug: "support-bot-copy",
      instanceId: "9",
      warnings: [{ type: "secret", message: "Secret OPENAI_KEY was not exported" }],
    });
    const { container } = render(<InstancesPage />);
    await screen.findByRole("link", { name: /Support Bot/ });

    await chooseFile(container, JSON.stringify(BUNDLE));

    const drawer = await screen.findByRole("dialog");
    expect(mockImportNew).not.toHaveBeenCalled();
    expect(within(drawer).getByText("openai · gpt-5")).toBeInTheDocument();
    // Each kind is collapsed under its count; opening it shows the elements themselves.
    await user.click(within(drawer).getByRole("button", { name: /instances\.detail\.tabTools/ }));
    expect(within(drawer).getByText("search_kb")).toBeInTheDocument();
    expect(within(drawer).getByText("send_email")).toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: /exportImport\.importNew\.secrets/ }));
    expect(within(drawer).getByText("CRM_TOKEN")).toBeInTheDocument();

    const name = within(drawer).getByLabelText("instances.table.name");
    const slug = within(drawer).getByLabelText("instances.table.slug");
    expect(name).toHaveValue("Support Bot");
    expect(slug).toHaveValue("support-bot");
    await user.clear(name);
    await user.type(name, "Support Bot Copy");
    await user.clear(slug);
    await user.type(slug, "Support Bot Copy");
    await user.click(within(drawer).getByRole("button", { name: "exportImport.import.button" }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/organizations/acme/workspaces/sales/instances/support-bot-copy"),
    );
    expect(mockImportNew).toHaveBeenCalledWith({
      ...BUNDLE,
      instance: { ...BUNDLE.instance, name: "Support Bot Copy", slug: "support-bot-copy" },
    });
    // The list page unmounts on navigation, so importing does not re-read the list first.
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Secret OPENAI_KEY was not exported")).toBeInTheDocument();
  });

  it("keeps the drawer open on a taken slug and says so under the field", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ instances: AGENTS });
    mockImportNew.mockRejectedValue(new ApiError(409, 'Slug "support-bot" already exists'));
    const { container } = render(<InstancesPage />);
    await screen.findByRole("link", { name: /Support Bot/ });

    await chooseFile(container, JSON.stringify(BUNDLE));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "exportImport.import.button" }));

    expect(await within(drawer).findByRole("alert")).toHaveTextContent("exportImport.importNew.slugTaken");
    expect(within(drawer).getByLabelText("instances.table.slug")).toHaveAttribute("aria-invalid", "true");
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("refuses a JSON file that is not an exported agent without opening the drawer", async () => {
    mockList.mockResolvedValue({ instances: AGENTS });
    const { container } = render(<InstancesPage />);
    await screen.findByRole("link", { name: /Support Bot/ });

    await chooseFile(container, JSON.stringify({ type: "skills", skills: [] }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("exportImport.importNew.notAgentFile"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockImportNew).not.toHaveBeenCalled();
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
