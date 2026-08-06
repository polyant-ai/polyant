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
vi.mock("./triggers-webhooks-tab", () => ({ TriggersWebhooksTab: () => <div>tab-body:webhooks</div> }));
vi.mock("./triggers-scheduled-tab", () => ({ TriggersScheduledTab: () => <div>tab-body:scheduled</div> }));
vi.mock("./triggers-runs-tab", () => ({ TriggersRunsTab: () => <div>tab-body:runs</div> }));
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
/** Every address that was reachable before the regrouping — the contract a bookmark holds. */
const PREVIOUSLY_REACHABLE = [
  "general", "prompts", "tools", "skills", "knowledge", "settings",
  "channels", "analytics", "triggers",
  "room", "hooks", "privacy",
] as const;

/** What each of those addresses now renders. Only `triggers` moved: it stopped being one
 *  section holding three and its first leaf became the landing. */
const LANDS_ON: Record<string, string> = { triggers: "webhooks" };

describe("InstanceDetailPage — tab regrouping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstancesGet.mockResolvedValue({ instance: makeInstance() });
    resetSearch("");
  });

  // The rail is gone: the sidebar shows the agent's macro entries, and the page shows
  // the sections of the ONE that is lit — never all of them at once. That is the whole
  // point of the regrouping, so it is what this asserts.
  it("shows only the active macro's sections in the tab row", async () => {
    render(<InstanceDetailPage />);
    await screen.findByText("tab-body:general");

    // Configurazione holds General and Settings — and nothing from another macro.
    expect(screen.getByRole("tab", { name: "instances.detail.tabSettings" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "instances.detail.tabPrompts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "instances.detail.tabPrivacy" })).not.toBeInTheDocument();
  });

  // A macro with one section renders no row: a tab bar with a single tab is chrome
  // that says nothing.
  it("renders no tab row for a macro holding one section", async () => {
    resetSearch("tab=privacy");
    render(<InstanceDetailPage />);

    await waitFor(() => expect(screen.getByText("tab-body:privacy")).toBeInTheDocument());
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("shows only the default General tab's body on first render", async () => {
    render(<InstanceDetailPage />);
    await screen.findByText("tab-body:general");

    for (const value of PREVIOUSLY_REACHABLE) {
      if (value === "general") continue;
      expect(screen.queryByText(`tab-body:${LANDS_ON[value] ?? value}`)).not.toBeInTheDocument();
    }
  });

  it("selecting a section in the tab row shows its body and hides the previous one", async () => {
    const user = userEvent.setup();
    render(<InstanceDetailPage />);
    await screen.findByText("tab-body:general");

    await user.click(screen.getByRole("tab", { name: "instances.detail.tabSettings" }));

    await waitFor(() => expect(screen.getByText("tab-body:settings")).toBeInTheDocument());
    expect(screen.queryByText("tab-body:general")).not.toBeInTheDocument();
    // The address moved with it.
    expect(mockRouterPush).toHaveBeenCalledWith(
      expect.stringContaining("tab=settings"),
      expect.anything(),
    );
  });

  it("resolves the active tab directly from its `?tab=` address", async () => {
    resetSearch("tab=analytics");
    render(<InstanceDetailPage />);

    await waitFor(() => expect(screen.getByText("tab-body:analytics")).toBeInTheDocument());
    expect(screen.queryByText("tab-body:general")).not.toBeInTheDocument();
  });

  // A bookmark is a contract. Every address that worked before still resolves — the one
  // that was folded lands on its first leaf rather than on the default page.
  it("keeps every previously-reachable address resolving", async () => {
    for (const value of PREVIOUSLY_REACHABLE) {
      resetSearch(`tab=${value}`);
      const { unmount } = render(<InstanceDetailPage />);
      const expected = LANDS_ON[value] ?? value;
      await waitFor(() => expect(screen.getByText(`tab-body:${expected}`)).toBeInTheDocument());
      unmount();
    }
  });

  it("falls back to the General tab for an unknown `?tab=` value", async () => {
    resetSearch("tab=not-a-real-tab");
    render(<InstanceDetailPage />);

    await waitFor(() => expect(screen.getByText("tab-body:general")).toBeInTheDocument());
  });
});
