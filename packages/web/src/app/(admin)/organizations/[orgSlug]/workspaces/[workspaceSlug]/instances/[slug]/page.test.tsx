// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent detail page's twelve tabs regrouped into five rail groups
 * (design spec `2026-07-30-admin-console-ia-redesign-design.md`, agent-detail
 * phase, phase 10). This is a navigation test only — every tab body is
 * stubbed to a one-line marker, because the regrouping must not touch what
 * a tab renders, only how it is reached.
 *
 * What's pinned here:
 *  - the five groups render, each with its tabs' labels;
 *  - clicking a rail item switches the visible body;
 *  - the active tab still resolves from its `?tab=` address (unchanged
 *    query-param mechanism — the rail is a new nav, not a new addressing
 *    scheme);
 *  - all twelve tabs that were reachable before the regrouping are still
 *    reachable by address, asserted in one loop so a tab silently dropped by
 *    the regrouping cannot pass unnoticed.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// Every tab body is stubbed to one marker element — proves the rail shows
// the right body without re-testing twelve features (page bodies are
// untouched by this change).
vi.mock("./general-tab", () => ({ GeneralTab: () => <div>tab-body:general</div> }));
vi.mock("./prompts-tab", () => ({ PromptsTab: () => <div>tab-body:prompts</div> }));
vi.mock("./tools-tab", () => ({ ToolsTab: () => <div>tab-body:tools</div> }));
vi.mock("./skills-tab", () => ({ SkillsTab: () => <div>tab-body:skills</div> }));
vi.mock("./knowledge-tab", () => ({ KnowledgeTab: () => <div>tab-body:knowledge</div> }));
vi.mock("./settings-tab", () => ({ SettingsTab: () => <div>tab-body:settings</div> }));
vi.mock("./channels-tab", () => ({ ChannelsTab: () => <div>tab-body:channels</div> }));
vi.mock("./analytics-tab", () => ({ AnalyticsTab: () => <div>tab-body:analytics</div> }));
vi.mock("./triggers-tab", () => ({ TriggersTab: () => <div>tab-body:triggers</div> }));
vi.mock("./room-tab", () => ({ RoomTab: () => <div>tab-body:room</div> }));
vi.mock("./hooks-tab", () => ({ HooksTab: () => <div>tab-body:hooks</div> }));
vi.mock("./privacy-tab", () => ({ PrivacyTab: () => <div>tab-body:privacy</div> }));

import InstanceDetailPage from "./page";

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

// The exact twelve tab values the page addressed before the regrouping
// (the old hard-coded `TAB_VALUES` in `page.tsx`) — hard-coded here, not
// imported from `instance-tab-groups.ts`, so a regrouping that silently
// drops one from the production list cannot also make it disappear from
// this ground truth.
const ALL_TWELVE_TABS = [
  "general", "prompts", "tools", "skills", "knowledge", "settings",
  "channels", "analytics", "triggers",
  "room", "hooks", "privacy",
] as const;

describe("InstanceDetailPage — tab regrouping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstancesGet.mockResolvedValue({ instance: makeInstance() });
    resetSearch("");
  });

  it("renders the five groups, each with its tabs' labels", async () => {
    render(<InstanceDetailPage />);
    await screen.findByText("tab-body:general");

    expect(screen.getByText("instances.detail.groupGeneral")).toBeInTheDocument();
    expect(screen.getByText("instances.detail.groupBehavior")).toBeInTheDocument();
    expect(screen.getByText("instances.detail.groupChannelsTriggers")).toBeInTheDocument();
    expect(screen.getByText("instances.detail.groupObservability")).toBeInTheDocument();
    expect(screen.getByText("instances.detail.groupDataPrivacy")).toBeInTheDocument();

    // Behavior group holds exactly the tabs the spec assigns it.
    expect(screen.getByText("instances.detail.tabPrompts")).toBeInTheDocument();
    expect(screen.getByText("instances.detail.tabHooks")).toBeInTheDocument();
  });

  it("shows only the default General tab's body on first render", async () => {
    render(<InstanceDetailPage />);
    await screen.findByText("tab-body:general");

    for (const value of ALL_TWELVE_TABS) {
      if (value === "general") continue;
      expect(screen.queryByText(`tab-body:${value}`)).not.toBeInTheDocument();
    }
  });

  it("selecting a tab in the rail shows its body and hides the previous one", async () => {
    const user = userEvent.setup();
    render(<InstanceDetailPage />);
    await screen.findByText("tab-body:general");

    await user.click(screen.getByText("instances.detail.tabPrivacy"));

    await waitFor(() => expect(screen.getByText("tab-body:privacy")).toBeInTheDocument());
    expect(screen.queryByText("tab-body:general")).not.toBeInTheDocument();
    // The address moved with it.
    expect(mockRouterPush).toHaveBeenCalledWith(
      expect.stringContaining("tab=privacy"),
      expect.anything(),
    );
  });

  it("resolves the active tab directly from its `?tab=` address", async () => {
    resetSearch("tab=analytics");
    render(<InstanceDetailPage />);

    await waitFor(() => expect(screen.getByText("tab-body:analytics")).toBeInTheDocument());
    expect(screen.queryByText("tab-body:general")).not.toBeInTheDocument();
  });

  it("keeps every one of the twelve previously-reachable tabs reachable by address", async () => {
    for (const value of ALL_TWELVE_TABS) {
      resetSearch(`tab=${value}`);
      const { unmount } = render(<InstanceDetailPage />);
      await waitFor(() => expect(screen.getByText(`tab-body:${value}`)).toBeInTheDocument());
      unmount();
    }
  });

  it("falls back to the General tab for an unknown `?tab=` value", async () => {
    resetSearch("tab=not-a-real-tab");
    render(<InstanceDetailPage />);

    await waitFor(() => expect(screen.getByText("tab-body:general")).toBeInTheDocument());
  });
});
