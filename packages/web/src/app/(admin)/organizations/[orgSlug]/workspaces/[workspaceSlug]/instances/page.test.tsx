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

    await user.click(await screen.findByRole("button", { name: /Support Bot/ }));
    expect(mockPush).toHaveBeenCalledWith("/organizations/acme/workspaces/sales/instances/support-bot");
    expect(screen.queryByText("Old Bot")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /instances\.filter\.all/ }));

    expect(screen.getByRole("button", { name: /Old Bot/ })).toBeInTheDocument();
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

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("common.loadFailed"));
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
    await screen.findByRole("button", { name: /Support Bot/ });

    const bundle = { version: 1, instance: { slug: "imported-bot" } };
    const file = new File([JSON.stringify(bundle)], "bundle.json", { type: "application/json" });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/organizations/acme/workspaces/sales/instances/imported-bot"),
    );
    expect(mockImportNew).toHaveBeenCalledWith(bundle);
    expect(mockList).toHaveBeenCalledTimes(2);
    const warnings = await screen.findByRole("dialog");
    expect(within(warnings).getByText("Secret OPENAI_KEY was not exported")).toBeInTheDocument();
  });

  it("rejects a file that is not JSON without calling the engine", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ instances: AGENTS });
    const { container } = render(<InstancesPage />);
    await screen.findByRole("button", { name: /Support Bot/ });

    const file = new File(["not json"], "bundle.json", { type: "application/json" });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("exportImport.import.failed"));
    expect(mockImportNew).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
