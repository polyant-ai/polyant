// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpServersTab } from "./mcp-servers-tab";
import type { McpServer } from "@/lib/api";

const { mockList, mockSet, mockConnect, mockDisconnect } = vi.hoisted(() => ({
  mockList: vi.fn(),
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
      delete: vi.fn(),
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

    expect(await screen.findByText("mcp.shared.notConnected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "mcp.shared.connect" }));

    await waitFor(() => expect(tab.location.assign).toHaveBeenCalledWith("https://idp.test/authorize?client_id=c1"));
    expect(mockConnect).toHaveBeenCalledWith("agent", "linear");
    expect(tab.opener).toBeNull();
    expect(screen.getByText("mcp.shared.waiting")).toBeInTheDocument();
    open.mockRestore();
  });

  it("shows a connected account and disconnects it", async () => {
    mockList.mockResolvedValue([sharedServer({ connectedAt: "2026-10-13T10:00:00.000Z", connectedBy: "u1" })]);
    mockDisconnect.mockResolvedValue({ disconnected: true });
    const user = userEvent.setup();
    render(<McpServersTab slug="agent" />);

    expect(await screen.findByText("mcp.shared.connectedOn")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "mcp.shared.connect" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "mcp.shared.disconnect" }));

    expect(mockDisconnect).toHaveBeenCalledWith("agent", "linear");
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it("offers no connect control for a server that authorizes per conversation", async () => {
    mockList.mockResolvedValue([{ ...sharedServer(null), config: { account: "conversation" } }]);
    render(<McpServersTab slug="agent" />);

    expect(await screen.findByText("Linear")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "mcp.shared.connect" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "common.save" }));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("mcp.validation.slugTaken"));
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("keeps the shared choice when an admin edits and saves the server", async () => {
    mockList.mockResolvedValue([sharedServer(null)]);
    mockSet.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { container } = render(<McpServersTab slug="agent" />);

    await screen.findByText("Linear");
    // The edit control is the first icon button in the row's actions cell.
    const editButton = container.querySelector("tbody td:last-child button") as HTMLButtonElement;
    await user.click(editButton);
    await user.click(await screen.findByRole("button", { name: "common.save" }));

    await waitFor(() => expect(mockSet).toHaveBeenCalled());
    expect(mockSet.mock.calls[0][2].config).toMatchObject({ account: "shared" });
  });
});
