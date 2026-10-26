// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpServersTab } from "./mcp-servers-tab";
import type { McpServer } from "@/lib/api";

const { mockList, mockSet, mockDelete, mockConnect, mockDisconnect } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockDelete: vi.fn(),
  mockSet: vi.fn(),
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
}));

const i18n = vi.hoisted(() => ({ t: (key: string) => key, locale: "en", setLocale: () => {} }));
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => i18n }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  api: {
    mcpServers: {
      list: (...a: unknown[]) => mockList(...a),
      set: (...a: unknown[]) => mockSet(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
      test: vi.fn(),
      connectShared: (...a: unknown[]) => mockConnect(...a),
      disconnectShared: (...a: unknown[]) => mockDisconnect(...a),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

function sharedServer(sharedAccount: McpServer["sharedAccount"]): McpServer {
  return {
    id: "row-1",
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.test/mcp",
    authMode: "oauth",
    enabled: true,
    config: { account: "shared" },
    sharedAccount,
  };
}

/** Opens a server's drawer from its row. */
async function openServer(user: ReturnType<typeof userEvent.setup>, name: string): Promise<HTMLElement> {
  await user.click((await screen.findByText(name)).closest("tr") as HTMLElement);
  return screen.findByRole("dialog");
}

describe("McpServersTab — the agent's shared account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the provider's authorize page in a new tab when an admin connects the account", async () => {
    mockList.mockResolvedValue([sharedServer(null)]);
    mockConnect.mockResolvedValue({ authorizeUrl: "https://idp.test/authorize?client_id=c1" });
    const tab = { opener: {} as unknown, location: { assign: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);

    // The row says whether the account is connected; the control to connect it is in the drawer.
    expect(await screen.findByText("mcp.shared.notConnected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "mcp.shared.connect" })).not.toBeInTheDocument();
    const drawer = await openServer(user, "Linear");
    await user.click(within(drawer).getByRole("button", { name: "mcp.shared.connect" }));

    await waitFor(() => expect(tab.location.assign).toHaveBeenCalledWith("https://idp.test/authorize?client_id=c1"));
    expect(mockConnect).toHaveBeenCalledWith("agent", "linear");
    expect(tab.opener).toBeNull();
    expect(screen.getAllByText("mcp.shared.waiting").length).toBeGreaterThan(0);
    open.mockRestore();
  });

  it("shows a connected account and disconnects it", async () => {
    mockList.mockResolvedValue([sharedServer({ connectedAt: "2026-10-13T10:00:00.000Z", connectedBy: "u1" })]);
    mockDisconnect.mockResolvedValue({ disconnected: true });
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);

    expect(await screen.findByText("mcp.shared.connectedOn")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "mcp.shared.disconnect" })).not.toBeInTheDocument();
    const drawer = await openServer(user, "Linear");
    expect(within(drawer).queryByRole("button", { name: "mcp.shared.connect" })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "mcp.shared.disconnect" }));

    expect(mockDisconnect).toHaveBeenCalledWith("agent", "linear");
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it("offers no connect control for a server that authorizes per conversation", async () => {
    mockList.mockResolvedValue([{ ...sharedServer(null), config: { account: "conversation" } }]);
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);

    const drawer = await openServer(user, "Linear");
    expect(within(drawer).queryByRole("button", { name: "mcp.shared.connect" })).not.toBeInTheDocument();
  });

  it("refuses a new server under a slug the agent already uses, instead of replacing it", async () => {
    mockList.mockResolvedValue([sharedServer(null)]);
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);

    await screen.findByText("Linear");
    await user.click(screen.getByRole("button", { name: /mcp\.add/ }));
    await user.type(screen.getByPlaceholderText("my-mcp-server"), "linear");
    await user.type(screen.getByPlaceholderText("My MCP Server"), "Another Linear");
    await user.type(screen.getByPlaceholderText("https://mcp.example.com/mcp"), "https://other.test/mcp");

    // The button waits for a form the engine would accept: the taken slug keeps it off.
    expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "common.add" })).toBeDisabled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("keeps the shared choice when an admin edits and saves the server", async () => {
    mockList.mockResolvedValue([sharedServer(null)]);
    mockSet.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);

    const drawer = await openServer(user, "Linear");
    await user.click(within(drawer).getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(mockSet).toHaveBeenCalled());
    expect(mockSet.mock.calls[0][2].config).toMatchObject({ account: "shared" });
  });
});

describe("McpServersTab — the list", () => {
  const servers: McpServer[] = [
    { ...sharedServer(null), id: "r1", slug: "linear", name: "Linear" },
    { id: "r2", slug: "notion", name: "Notion", url: "https://mcp.notion.test/mcp", authMode: "static", enabled: false, config: {} },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue(servers);
  });

  it("filters the servers on name, slug and url as typed", async () => {
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);
    await screen.findByText("Linear");
    const search = screen.getByRole("searchbox", { name: "common.search" });

    await user.type(search, "notion.test");
    expect(screen.getByText("Notion")).toBeInTheDocument();
    expect(screen.queryByText("Linear")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("common.noResults")).toBeInTheDocument();
  });

  it("has an Active switch per row in the last column and no edit or delete buttons on the rows", async () => {
    render(<McpServersTab slug="agent" />);
    await screen.findByText("Linear");

    const row = screen.getByText("Linear").closest("tr") as HTMLElement;
    expect(within(row).getByRole("switch", { name: "mcp.enabled" })).toBeChecked();
    expect(within(screen.getByText("Notion").closest("tr") as HTMLElement).getByRole("switch")).not.toBeChecked();
    const cells = within(row).getAllByRole("cell");
    expect(within(cells[cells.length - 1]).getByRole("switch")).toBeInTheDocument();
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });

  it("toggling the switch saves the server without opening the drawer", async () => {
    mockSet.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);
    await screen.findByText("Linear");

    await user.click(within(screen.getByText("Notion").closest("tr") as HTMLElement).getByRole("switch"));

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith("agent", "notion", expect.objectContaining({ enabled: true })));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("edits in a drawer, not a dialog, and deletes only from it after the confirmation", async () => {
    mockDelete.mockResolvedValue({});
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);

    const drawer = await openServer(user, "Notion");
    expect(drawer).toHaveAttribute("data-slot", "sheet-content");
    expect(within(drawer).getByRole("heading", { name: "Notion" })).toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "common.delete" }));
    expect(mockDelete).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "common.delete" }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("agent", "notion"));
  });

  it("does not delete when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);
    const drawer = await openServer(user, "Notion");
    await user.click(within(drawer).getByRole("button", { name: "common.delete" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "common.cancel" }));
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("adds a server in a drawer with no delete button", async () => {
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);
    await screen.findByText("Linear");
    await user.click(screen.getByRole("button", { name: /mcp\.add/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "mcp.createTitle" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "common.delete" })).not.toBeInTheDocument();
  });

  it("states a failed load and an empty list distinctly", async () => {
    mockList.mockRejectedValueOnce(new Error("down"));
    const { unmount } = render(<McpServersTab slug="agent" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("mcp.loadFailed");
    unmount();

    mockList.mockResolvedValue([]);
    render(<McpServersTab slug="agent" />);
    expect(await screen.findByText("mcp.empty")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("lists the servers alphabetically by name", async () => {
    mockList.mockResolvedValue([
      { id: "r2", slug: "notion", name: "Notion", url: "https://n.test/mcp", authMode: "static", enabled: true, config: {} },
      { id: "r1", slug: "asana", name: "Asana", url: "https://a.test/mcp", authMode: "static", enabled: true, config: {} },
    ]);
    render(<McpServersTab slug="agent" />);
    await screen.findByText("Notion");
    const names = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("button")[0].textContent);
    expect(names).toEqual(["Asana", "Notion"]);
  });

  it("ends the drawer with Delete on the left, then Cancel and Save", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue([{ id: "r2", slug: "notion", name: "Notion", url: "https://n.test/mcp", authMode: "static", enabled: true, config: {} }]);
    render(<McpServersTab slug="agent" />);
    const drawer = await openServer(user, "Notion");
    const footer = drawer.querySelector("[data-slot=sheet-footer]") as HTMLElement;
    expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual(["common.delete", "common.cancel", "common.save"]);
  });
});
