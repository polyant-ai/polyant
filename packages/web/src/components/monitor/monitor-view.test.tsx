// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { FeedEvent } from "@/lib/activity-stream/types";
import type { MonitorDetail, MonitorItem, MonitorPage } from "@/lib/api-types";
import { renderWithProviders } from "@/test-utils";

const list = vi.fn<(params?: Record<string, unknown>) => Promise<MonitorPage>>();
const detail = vi.fn<(type: string, id: string) => Promise<MonitorDetail>>();

vi.mock("@/lib/api", () => ({
  api: {
    monitor: {
      list: (params?: Record<string, unknown>) => list(params),
      detail: (type: string, id: string) => detail(type, id),
    },
    instances: { list: async () => ({ instances: [{ id: "i1", slug: "sales", name: "Sales" }, { id: "i2", slug: "ops", name: "Ops" }] }) },
  },
}));

let stream: { events: FeedEvent[]; realLive: boolean };
vi.mock("@/lib/activity-stream/provider", () => ({ useActivityStreamContext: () => stream }));
vi.mock("@/lib/tenant/use-tenant-paths", () => ({
  useTenantPaths: () => ({ workspace: (sub: string) => `/organizations/acme/workspaces/main${sub}`, org: () => "/organizations/acme" }),
}));

import {
  registerMonitorConversationHref,
  registerMonitorLevel,
  registerMonitorSummary,
  type MonitorEndpoint,
  type MonitorListParams,
} from "@/lib/monitor/extensions";
import { registerMonitorLabels } from "./monitor-labels";
import { MonitorView } from "./monitor-view";
import { NO_FILTERS, type MonitorFilters } from "./use-monitor-feed";

const TYPES = [
  { type: "tool_call", group: "agents", retentionDays: 90 },
  { type: "hook", group: "agents", retentionDays: 90 },
  { type: "webhook", group: "automations", retentionDays: null },
  { type: "scheduled_run", group: "automations", retentionDays: 90 },
];

function item(partial: Partial<MonitorItem>): MonitorItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type: "tool_call",
    group: "agents",
    time: "2026-03-01T10:00:00.000000Z",
    agent: { slug: "sales", name: "Sales" },
    conversationId: null,
    summary: "crm: create_contact",
    outcome: "ok",
    durationMs: 12,
    ...partial,
  };
}

function Harness({ initial = NO_FILTERS, lockedAgent, level }: { initial?: MonitorFilters; lockedAgent?: string; level?: string }) {
  const [value, setValue] = useState(initial);
  return <MonitorView value={value} onChange={setValue} lockedAgent={lockedAgent} level={level} />;
}

beforeEach(() => {
  list.mockReset();
  detail.mockReset();
  stream = { events: [], realLive: true };
  list.mockResolvedValue({ items: [item({}), item({ id: "00000000-0000-4000-8000-000000000002", type: "scheduled_run", group: "automations", summary: "Nightly", outcome: "error", time: "2026-03-01T09:00:00.000000Z" })], nextCursor: null, types: TYPES });
});

describe("MonitorView", () => {
  it("shows the stored rows with type and outcome pills", async () => {
    renderWithProviders(<Harness />);
    expect(await screen.findByText("crm: create_contact")).toBeInTheDocument();
    expect(screen.getByText("Nightly")).toBeInTheDocument();
    expect(screen.getAllByText("Tools").length).toBeGreaterThan(0);
    expect(screen.queryByText("Strumenti")).not.toBeInTheDocument();
    expect(screen.getByText("Errore")).toBeInTheDocument();
  });

  it("asks for one group when its chip is chosen, and again for everything on «Tutto»", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await screen.findByText("crm: create_contact");
    await user.click(screen.getByRole("tab", { name: "Automazioni" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ group: "automations" })));
    await user.click(screen.getByRole("tab", { name: "Tutto" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ group: undefined })));
  });

  it("opens the Monitor already narrowed to one type, and lets the user lift the narrowing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ ...NO_FILTERS, group: "agents", type: "tool_call" }} />);
    await screen.findByText("crm: create_contact");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ group: "agents", types: ["tool_call"] }));
    await user.click(screen.getByRole("button", { name: "Togli il filtro" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ types: undefined })));
  });

  it("sends the outcome filter to the engine", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await screen.findByText("crm: create_contact");
    await user.click(screen.getByRole("combobox", { name: "Esito" }));
    await user.click(await screen.findByRole("option", { name: "Con errore" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "error" })));
  });

  it("sends the search text after typing pauses", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await screen.findByText("crm: create_contact");
    await user.type(screen.getByRole("searchbox"), "hubspot");
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "hubspot" })));
  });

  it("pins the list to the locked agent and offers no agent filter", async () => {
    renderWithProviders(<Harness lockedAgent="sales" />);
    await screen.findByText("crm: create_contact");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ agent: "sales" }));
    expect(screen.queryByRole("combobox", { name: "Agente" })).not.toBeInTheDocument();
    // Same columns as everywhere else: the agent column stays.
    expect(screen.getByRole("columnheader", { name: "Agente" })).toBeInTheDocument();
  });

  it("loads the next page with the cursor the engine gave", async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce({ items: [item({})], nextCursor: "CURSOR-1", types: TYPES });
    list.mockResolvedValueOnce({ items: [item({ id: "00000000-0000-4000-8000-000000000009", summary: "older call", time: "2026-02-01T10:00:00.000000Z" })], nextCursor: null, types: TYPES });
    renderWithProviders(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Carica altre voci" }));
    expect(await screen.findByText("older call")).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "CURSOR-1" }));
    expect(screen.queryByRole("button", { name: "Carica altre voci" })).not.toBeInTheDocument();
  });

  it("opens a drawer with a tool call's arguments, output and duration read from the engine", async () => {
    const user = userEvent.setup();
    detail.mockResolvedValue({
      ...item({}),
      error: null,
      sections: [
        { key: "arguments", kind: "json", value: { customerEmail: "a@example.com", dryRun: false, tags: ["x"] } },
        { key: "output", kind: "text", value: "created" },
      ],
    });
    renderWithProviders(<Harness />);
    await user.click(await screen.findByText("crm: create_contact"));
    const drawer = await screen.findByRole("dialog");
    expect(detail).toHaveBeenCalledWith("tool_call", "00000000-0000-4000-8000-000000000001");
    expect(await within(drawer).findByText(/a@example\.com/)).toBeInTheDocument();
    expect(within(drawer).getByText("Argomenti")).toBeInTheDocument();
    // Known sections read as labelled rows, not as raw JSON.
    expect(within(drawer).getByText("Customer email")).toBeInTheDocument();
    expect(within(drawer).getByText("Dry run")).toBeInTheDocument();
    expect(within(drawer).getByText("No")).toBeInTheDocument();
    expect(within(drawer).queryByText(/"customerEmail"/)).toBeNull();
    expect(within(drawer).getByText("created")).toBeInTheDocument();
    expect(within(drawer).getByText("12ms")).toBeInTheDocument();
    expect(within(drawer).getByText("Conservata per 90 giorni.")).toBeInTheDocument();
  });

  it("shows a failed run's error and a link to its conversation, and says webhook rows have no own expiry", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({
      items: [item({ id: "00000000-0000-4000-8000-0000000000aa", type: "scheduled_run", group: "automations", summary: "Nightly", outcome: "error", conversationId: "sales:web:1" }), item({ id: "00000000-0000-4000-8000-0000000000bb", type: "webhook", group: "automations", summary: "Order received" })],
      nextCursor: null,
      types: TYPES,
    });
    detail.mockImplementation(async (type, id) => ({
      ...item({ id, type, group: "automations", summary: type === "webhook" ? "Order received" : "Nightly", outcome: type === "webhook" ? "ok" : "error", conversationId: type === "webhook" ? null : "sales:web:1" }),
      error: type === "webhook" ? null : "model unavailable",
      sections: [],
    }));
    renderWithProviders(<Harness />);
    await user.click(await screen.findByText("Nightly"));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("model unavailable")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: /Apri la conversazione/ })).toHaveAttribute(
      "href",
      "/organizations/acme/workspaces/main/conversations?id=sales%3Aweb%3A1",
    );
    await user.keyboard("{Escape}");
    await user.click(screen.getByText("Order received"));
    expect(await screen.findByText("Conservata finché esiste la conversazione, senza scadenza automatica.")).toBeInTheDocument();
  });

  it("puts a live event on top at once, and says where live updates come from", async () => {
    stream = { events: [], realLive: true };
    const view = renderWithProviders(<Harness />);
    await screen.findByText("crm: create_contact");
    expect(screen.getByText("Gli aggiornamenti in tempo reale arrivano dal server a cui sei collegato.")).toBeInTheDocument();
    expect(screen.getByText("In tempo reale")).toBeInTheDocument();

    stream = {
      realLive: true,
      events: [
        {
          id: "tool:c:1",
          ts: "2026-03-01T11:00:00.000Z",
          persona: "agent",
          text: "x",
          instance: { id: "i1", slug: "sales", name: "Sales", icon: null },
          tool: { name: "search", summary: "q" },
          status: "success",
        },
      ],
    };
    await act(async () => view.rerender(<Harness />));
    const rows = await screen.findAllByRole("row");
    expect(within(rows[1]!).getByText("search: q")).toBeInTheDocument();
  });

  it("stops adding live rows while paused", async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<Harness />);
    await screen.findByText("crm: create_contact");
    await user.click(screen.getByRole("button", { name: "Pausa" }));
    expect(screen.getByText("In pausa")).toBeInTheDocument();
    stream = {
      realLive: true,
      events: [{ id: "tool:c:2", ts: "2026-03-01T11:00:00.000Z", persona: "agent", text: "x", instance: { id: "i1", slug: "sales", name: "Sales", icon: null }, tool: { name: "late", summary: "" }, status: "success" }],
    };
    await act(async () => view.rerender(<Harness />));
    expect(screen.queryByText("late")).not.toBeInTheDocument();
  });

  it("says it is not connected when the stream is down", async () => {
    stream = { events: [], realLive: false };
    renderWithProviders(<Harness />);
    expect(await screen.findByText("Non connesso")).toBeInTheDocument();
  });

  it("tells an empty installation from an empty filter", async () => {
    list.mockResolvedValue({ items: [], nextCursor: null, types: TYPES });
    const view = renderWithProviders(<Harness />);
    expect(await screen.findByText("Ancora niente da mostrare")).toBeInTheDocument();
    view.unmount();
    renderWithProviders(<Harness initial={{ ...NO_FILTERS, outcome: "error" }} />);
    expect(await screen.findByText("Nessun risultato")).toBeInTheDocument();
  });

  it("states a failed read with a retry instead of an empty table", async () => {
    list.mockRejectedValueOnce(new Error("boom"));
    renderWithProviders(<Harness />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Ancora niente da mostrare")).not.toBeInTheDocument();
  });
});

describe("MonitorView with parts a build registers", () => {
  const wideList = vi.fn<(params?: MonitorListParams) => Promise<MonitorPage>>();
  const wideDetail = vi.fn<(type: string, id: string) => Promise<MonitorDetail>>();
  const wide: MonitorEndpoint = { key: "wide:1", list: (params) => wideList(params), detail: (type, id) => wideDetail(type, id) };
  let endpoint: MonitorEndpoint | null;

  const note = (partial: Partial<MonitorItem> = {}): MonitorItem =>
    item({
      id: "00000000-0000-4000-8000-0000000000b1",
      type: "note",
      group: "notes",
      agent: { slug: "", name: "" },
      summary: "note.created",
      durationMs: null,
      facts: { what: "created", who: "ada" },
      ...partial,
    });

  beforeAll(() => {
    registerMonitorLevel("wide", { useEndpoint: () => endpoint, defaultGroups: ["notes"], agentFilter: false, conversationLinks: false });
    registerMonitorLabels({ typeShort: { note: "monitor.type.hook" }, groups: { notes: "monitor.group.automations" } });
    registerMonitorSummary("note", (row) => (row.facts?.what ? `${row.facts.who} ha fatto: ${row.facts.what}` : undefined));
  });

  beforeEach(() => {
    wideList.mockReset();
    wideDetail.mockReset();
    endpoint = wide;
    wideList.mockResolvedValue({ items: [note()], nextCursor: null, types: [{ type: "note", group: "notes", retentionDays: null }] });
  });

  it("reads the level from the endpoint it registered and never from the default one", async () => {
    renderWithProviders(<Harness level="wide" />);
    await screen.findByText("ada ha fatto: created");
    expect(wideList).toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("waits while the endpoint is not resolved, instead of asking for nobody's data", async () => {
    endpoint = null;
    renderWithProviders(<Harness level="wide" />);
    await act(async () => {});
    expect(wideList).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("starts from the chips the level names, labelled by what was registered", async () => {
    wideList.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Harness level="wide" />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Tutto", "Automazioni"]);
  });

  it("offers no agent filter where the level says there is none, and leaves the agent column empty", async () => {
    renderWithProviders(<Harness level="wide" />);
    const row = (await screen.findByText("ada ha fatto: created")).closest("tr")!;
    expect(screen.queryByRole("combobox", { name: "Agente" })).not.toBeInTheDocument();
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("keeps the engine's summary for an item with no facts", async () => {
    wideList.mockResolvedValue({ items: [note({ facts: undefined })], nextCursor: null, types: [] });
    renderWithProviders(<Harness level="wide" />);
    expect(await screen.findByText("note.created")).toBeInTheDocument();
  });

  it("opens the drawer from the registered endpoint, with no conversation link and no expiry for a type kept on its own", async () => {
    const user = userEvent.setup();
    wideList.mockResolvedValue({ items: [note({ conversationId: "sales:web:1" })], nextCursor: null, types: [{ type: "note", group: "notes", retentionDays: null }] });
    wideDetail.mockResolvedValue({ ...note({ conversationId: "sales:web:1" }), error: null, sections: [] });
    renderWithProviders(<Harness level="wide" />);
    await user.click(await screen.findByText("ada ha fatto: created"));
    const drawer = await screen.findByRole("dialog");
    await waitFor(() => expect(wideDetail).toHaveBeenCalledWith("note", "00000000-0000-4000-8000-0000000000b1"));
    expect(detail).not.toHaveBeenCalled();
    expect(within(drawer).queryByRole("link", { name: /Apri la conversazione/ })).not.toBeInTheDocument();
    expect(within(drawer).getByText("Nessuna scadenza automatica.")).toBeInTheDocument();
  });

  it("says a webhook row is kept as long as its conversation, and offers «Bloccati» as an outcome", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({ items: [item({ type: "webhook", group: "automations", summary: "crm → lead" })], nextCursor: null, types: TYPES });
    detail.mockResolvedValue({ ...item({ type: "webhook", group: "automations", summary: "crm → lead" }), error: null, sections: [] });
    renderWithProviders(<Harness />);
    await user.click(await screen.findByText("crm → lead"));
    expect(await screen.findByText(/finché esiste la conversazione/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("combobox", { name: "Esito" }));
    expect(await screen.findByRole("option", { name: "Bloccati" })).toBeInTheDocument();
  });

  it("opens a conversation where the build says it opens", async () => {
    const user = userEvent.setup();
    registerMonitorConversationHref((id, paths) => paths.workspace(`/chat/${id}`));
    list.mockResolvedValue({ items: [item({ conversationId: "c9" })], nextCursor: null, types: TYPES });
    detail.mockResolvedValue({ ...item({ conversationId: "c9" }), error: null, sections: [] });
    renderWithProviders(<Harness />);
    await user.click(await screen.findByText("crm: create_contact"));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("link", { name: /Apri la conversazione/ })).toHaveAttribute("href", "/organizations/acme/workspaces/main/chat/c9");
    registerMonitorConversationHref((id, paths) => paths.workspace(`/conversations?id=${encodeURIComponent(id)}`));
  });
});
