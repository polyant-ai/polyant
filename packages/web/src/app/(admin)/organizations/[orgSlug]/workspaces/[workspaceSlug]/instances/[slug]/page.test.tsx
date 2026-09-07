// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent page under the flat navigation: TWENTY-THREE sections, every one of
 * them a sidebar row, and no tab row on the page at all.
 *
 * A navigation test only — every section body is stubbed to a one-line marker,
 * because reorganising how a section is REACHED must not change what it renders.
 *
 * What is pinned here:
 *  - the page lands on the overview, alone;
 *  - every section resolves from its `?tab=` address;
 *  - the addresses of the sections that MERGED resolve to nothing and land on the
 *    default, because there is no alias table anywhere in the panel;
 *  - the page renders no tab row, and names the open section itself — with the tab
 *    row gone, the heading is the only thing on the page saying where you are.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import type { Instance } from "@/lib/api";

// ── A minimal, stateful next/navigation double ──────────────────────────
// Real enough to prove the query-param addressing survives: `router.push`
// updates a shared store, and `useSearchParams` re-renders from it via
// `useSyncExternalStore` — so a click-driven `?tab=` change is genuinely
// reactive, not just an assertion on the mock's call args.
const { mockRouterPush, resetSearch, setSearch } = vi.hoisted(() => {
  let params = new URLSearchParams();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    mockRouterPush: vi.fn((url: string) => {
      const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      params = new URLSearchParams(qs);
      notify();
    }),
    resetSearch: (qs: string) => {
      params = new URLSearchParams(qs);
      notify();
    },
    setSearch: {
      subscribe: (onChange: () => void) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      get: () => params,
    },
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "test-instance" }),
  useRouter: () => ({ push: mockRouterPush }),
  usePathname: () => "/organizations/acme/workspaces/vendite/instances/test-instance",
  useSearchParams: () =>
    useSyncExternalStore(setSearch.subscribe, setSearch.get, setSearch.get),
}));

vi.mock("@/lib/tenant/use-tenant-paths", () => ({
  useTenantPaths: () => ({
    workspace: (sub: string) => `/organizations/acme/workspaces/vendite${sub}`,
    org: (sub?: string) => `/organizations/acme${sub ?? ""}`,
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

const mockInstancesGet = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    instances: { get: (...args: unknown[]) => mockInstancesGet(...args), delete: vi.fn() },
    tools: { list: vi.fn(() => Promise.resolve({ tools: [] })) },
    skills: { list: vi.fn(() => Promise.resolve({ skills: [] })) },
    prompts: { list: vi.fn(() => Promise.resolve({ prompts: [] })) },
    exportImport: { exportInstance: vi.fn() },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

// Every section body is stubbed to one marker element — proves the address
// reaches the right body without re-testing eighteen features.
vi.mock("./general-tab", () => ({ GeneralTab: () => <div>tab-body:general</div> }));
vi.mock("./prompts-tab", () => ({ PromptsTab: () => <div>tab-body:prompts</div> }));
// The merged sections are stubbed at the COMPOSITE, not at its parts: what the
// page addresses now is the composite, and the parts' own tests still cover them.
vi.mock("./tools-tab", () => ({ ToolsTab: () => <div>tab-body:tools</div> }));
vi.mock("./mcp-servers-tab", () => ({ McpServersTab: () => <div>tab-body:mcp</div> }));
vi.mock("./skills-tab", () => ({ SkillsTab: () => <div>tab-body:skills</div> }));
vi.mock("./knowledge-tab", () => ({ KnowledgeTab: () => <div>tab-body:knowledge</div> }));
// One component, two sections: which half it renders is the `section` prop, and
// the stub reports it — a copy-paste leaving both addresses on one half fails here.
vi.mock("./settings-tab", () => ({
  SettingsTab: ({ section }: { section: string }) => <div>tab-body:settings:{section}</div>,
}));
vi.mock("./channels-section", () => ({ ChannelsSection: () => <div>tab-body:channels</div> }));
vi.mock("./analytics-tab", () => ({ AnalyticsTab: () => <div>tab-body:analytics</div> }));
// Stubbed like every other body: this file is about navigation, and the status
// block makes its own requests (covered by `overview-status.test.tsx`).
vi.mock("./status-tab", () => ({ StatusTab: () => <div>tab-body:status</div> }));
vi.mock("./logs-tab", () => ({ LogsTab: () => <div>tab-body:logs</div> }));
vi.mock("./params-tab", () => ({ ParamsTab: () => <div>tab-body:params</div> }));
vi.mock("./agent-conversations-tab", () => ({
  AgentConversationsTab: () => <div>tab-body:conversations</div>,
}));
vi.mock("./agent-memories-tab", () => ({
  AgentMemoriesTab: () => <div>tab-body:memories</div>,
}));
vi.mock("./triggers-webhooks-tab", () => ({ TriggersWebhooksTab: () => <div>tab-body:webhooks</div> }));
vi.mock("./triggers-scheduled-tab", () => ({ TriggersScheduledTab: () => <div>tab-body:scheduled</div> }));
vi.mock("./room-tab", () => ({ RoomTab: () => <div>tab-body:room</div> }));
vi.mock("./hooks-tab", () => ({ HooksTab: () => <div>tab-body:hooks</div> }));
vi.mock("./privacy-tab", () => ({ PrivacyTab: () => <div>tab-body:privacy</div> }));

import InstanceDetailPage from "./page";
import { DEFAULT_AGENT_TAB } from "@/lib/nav/agent-sections";

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "test-instance",
    name: "Test Instance",
    description: "A test instance",
    status: "active",
    provider: "openai",
    model: "gpt-4o",
    memoryEnabled: true,
    knowledgeEnabled: false,
    langsmithEnabled: false,
    langsmithProject: null,
    authEnabled: false,
    thinkingEnabled: false,
    stateInPromptEnabled: false,
    datetimeInjectionEnabled: true,
    cacheEnabled: true,
    cacheTtl: "1h",
    toolResultsInHistoryEnabled: false,
    debugEnabled: false,
    optoutEnabled: false,
    optoutStopKeywords: [],
    optoutResumeKeywords: [],
    optoutClosingMessage: null,
    optoutResumeMessage: null,
    optoutInjectPromptHint: false,
    sttProvider: "openai",
    icon: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  } as Instance;
}

/**
 * Ground truth for the addresses, hard-coded rather than imported from the
 * registry: a reorganisation that drops a section should fail HERE, and it cannot
 * if this list is derived from the same data the page reads.
 */
const EVERY_SECTION = [
  "overview", "analytics",
  "general", "settings", "credentials", "channels",
  "prompts", "tools", "toolSecrets", "mcp", "skills", "knowledge", "hooks", "params",
  "webhooks", "scheduled", "room",
  "privacy",
  "conversations", "memories", "logs",
] as const;

/** Which stub body a section renders, where the two differ. */
const BODY_OF: Record<string, string> = {
  overview: "status",
  // One component, four pages: the stub reports which half it was asked for, so a
  // copy-paste leaving two addresses on one section fails here.
  settings: "settings:model",
  credentials: "settings:credentials",
  toolSecrets: "settings:toolSecrets",
};

/**
 * Addresses that used to name a section and no longer resolve — the six
 * per-channel ones, the two halves that merged into a page, and the two logs.
 * There is no alias table anywhere in the panel, so each of these is just an
 * unknown value and lands on the default section.
 *
 * `channels` is deliberately NOT here: the merge gave that address a section
 * again, and it is asserted as reachable above.
 */
const DROPPED_ADDRESSES = [
  "triggers",
  "governance",
  // Enterprise sections. They are not aliases either: an address that names
  // nothing in this build lands on the default section like any other.
  "policy",
  "compliance",
  "traces",
  "runs",
  "governanceEvents",
  "retention",
  "channelWeb",
  "channelTelegram",
  "channelAgent",
] as const;

describe("InstanceDetailPage — sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstancesGet.mockResolvedValue({ instance: makeInstance() });
    resetSearch("");
  });

  it("lands on the overview, alone", async () => {
    render(<InstanceDetailPage />);
    await screen.findByText("tab-body:status");

    for (const value of EVERY_SECTION) {
      if (value === "overview") continue;
      expect(screen.queryByText(`tab-body:${BODY_OF[value] ?? value}`)).not.toBeInTheDocument();
    }
  });

  it("resolves the active section directly from its `?tab=` address", async () => {
    resetSearch("tab=privacy");
    render(<InstanceDetailPage />);

    await waitFor(() => expect(screen.getByText("tab-body:privacy")).toBeInTheDocument());
    expect(screen.queryByText("tab-body:prompts")).not.toBeInTheDocument();
  });

  it("keeps every section reachable by address", async () => {
    for (const value of EVERY_SECTION) {
      resetSearch(`tab=${value}`);
      const { unmount } = render(<InstanceDetailPage />);
      const body = BODY_OF[value] ?? value;
      await waitFor(() => expect(screen.getByText(`tab-body:${body}`)).toBeInTheDocument());
      unmount();
    }
  });

  /**
   * The merged sections resolve to NOTHING now: the alias table is gone, matching
   * the rest of the panel, where a legacy address lands rather than forwarding.
   * Pinned so the removal is a decision and not a silent regression.
   */
  it("lands a dropped legacy address on the default section", async () => {
    for (const legacy of DROPPED_ADDRESSES) {
      resetSearch(`tab=${legacy}`);
      const { unmount } = render(<InstanceDetailPage />);
      const body = BODY_OF[DEFAULT_AGENT_TAB] ?? DEFAULT_AGENT_TAB;
      await waitFor(() => expect(screen.getByText(`tab-body:${body}`)).toBeInTheDocument());
      unmount();
    }
  });

  /**
   * There is NO tab row any more: the sidebar lists every section, so a tab bar
   * here would be the same vocabulary said twice, half of it hidden.
   */
  it("renders no tab row at all", async () => {
    resetSearch("tab=tools");
    render(<InstanceDetailPage />);
    await waitFor(() => expect(screen.getByText("tab-body:tools")).toBeInTheDocument());

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByText("tab-body:prompts")).not.toBeInTheDocument();
  });

  /**
   * The page NAMES the open section. Without the tab row, the only other thing
   * saying which section is open is the lit row in the sidebar — a different
   * surface, 500px away — and half the section bodies open with an unheaded
   * paragraph.
   */
  it("names the open section in a heading", async () => {
    resetSearch("tab=hooks");
    render(<InstanceDetailPage />);

    await waitFor(() => expect(screen.getByText("tab-body:hooks")).toBeInTheDocument());
    expect(
      screen.getByRole("heading", { name: "instances.detail.tabHooks", level: 2 }),
    ).toBeInTheDocument();
  });

  it("falls back to the overview for an unknown `?tab=` value", async () => {
    resetSearch("tab=not-a-real-tab");
    render(<InstanceDetailPage />);

    await waitFor(() => expect(screen.getByText("tab-body:status")).toBeInTheDocument());
  });
});
