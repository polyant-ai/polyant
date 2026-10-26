// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConversationListItem, ConversationMessage } from "@/lib/api";

// ── Mocks ────────────────────────────────────────────────────────────

const mockGet = vi.fn();
const mockMessages = vi.fn();
const mockHookExecutions = vi.fn();
const mockDelete = vi.fn();
const mockRename = vi.fn();
const mockPush = vi.fn();
const search = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      conversations: {
        get: (...args: unknown[]) => mockGet(...args),
        messages: (...args: unknown[]) => mockMessages(...args),
        hookExecutions: (...args: unknown[]) => mockHookExecutions(...args),
        delete: (...args: unknown[]) => mockDelete(...args),
        rename: (...args: unknown[]) => mockRename(...args),
      },
    },
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Stable identity: the page lists `t` in effect dependencies.
const i18nMock = { t: (key: string) => key, locale: "en", setLocale: vi.fn() };
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => i18nMock }));

// The id carries its agent as the first segment: `<instance>:<channel>:<id>`.
const CONVERSATION_ID = "bot-1:telegram:42";
const INSTANCE_ID = "bot-1";

const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useParams: () => ({
    orgSlug: "acme",
    workspaceSlug: "sales",
    conversationId: encodeURIComponent(CONVERSATION_ID),
  }),
  useSearchParams: () => search.current,
  usePathname: () => "/organizations/acme/workspaces/sales/conversations",
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Live following opens an EventSource; it is off by default and not under test.
vi.mock("@/hooks/use-live-conversation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-live-conversation")>();
  return { ...actual, useLiveConversation: () => ({ events: [], connected: false }) };
});

import ConversationDetailPage from "./page";

// ── Fixtures ─────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: "c1",
    conversationId: CONVERSATION_ID,
    title: "Booking a visit",
    summary: null,
    channel: "telegram",
    userIdentifier: null,
    instanceId: INSTANCE_ID,
    instanceName: "Front desk",
    messageCount: 2,
    totalTokens: 0,
    totalCost: 0,
    conversationTokens: 0,
    conversationCost: 0,
    serviceTokens: 0,
    serviceCost: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    createdAt: "2026-01-01T10:00:00Z",
    updatedAt: "2026-01-01T10:01:00Z",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: "m",
    role: "user",
    content: "",
    steps: null,
    reasoning: null,
    attachments: null,
    metadata: null,
    createdAt: "2026-01-01T10:00:00Z",
    promptTokens: null,
    completionTokens: null,
    ...overrides,
  };
}

// The engine answers newest first.
const MESSAGES_NEWEST_FIRST = [
  makeMessage({ id: "m2", role: "assistant", content: "Tuesday at 10 works.", createdAt: "2026-01-01T10:00:30Z" }),
  makeMessage({ id: "m1", role: "user", content: "Can I book a visit?", createdAt: "2026-01-01T10:00:00Z" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({ conversation: makeConversation() });
  mockMessages.mockResolvedValue({ messages: MESSAGES_NEWEST_FIRST, total: 2, limit: 50, offset: 0, order: "desc" });
  mockHookExecutions.mockResolvedValue({ executions: [] });
  mockDelete.mockResolvedValue({ deleted: true });
  mockRename.mockResolvedValue({ renamed: true, conversationId: CONVERSATION_ID });
});

async function renderLoaded() {
  const user = userEvent.setup();
  render(<ConversationDetailPage />);
  await screen.findByRole("heading", { name: "Booking a visit" });
  return user;
}

async function chooseAction(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("button", { name: "conversations.detail.moreActions" }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ConversationDetailPage", () => {
  it("loads the conversation scoped to the agent named in its id", async () => {
    await renderLoaded();

    expect(mockGet).toHaveBeenCalledWith(CONVERSATION_ID, INSTANCE_ID);
    expect(mockMessages).toHaveBeenCalledWith(
      CONVERSATION_ID,
      INSTANCE_ID,
      expect.objectContaining({ order: "desc" }),
    );
    expect(mockHookExecutions).toHaveBeenCalledWith(CONVERSATION_ID, INSTANCE_ID);
  });

  it("shows the messages in chronological order", async () => {
    await renderLoaded();

    const question = screen.getByText("Can I book a visit?");
    const answer = screen.getByText("Tuesday at 10 works.");
    // Newest-first from the engine, oldest-first on screen.
    expect(question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still opens when the decorative hook history fails to load", async () => {
    mockHookExecutions.mockRejectedValue(new Error("boom"));

    await renderLoaded();

    expect(screen.getByText("Can I book a visit?")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("returns to the list when the conversation cannot be loaded", async () => {
    mockGet.mockRejectedValue(new Error("not found"));

    render(<ConversationDetailPage />);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/organizations/acme/workspaces/sales/conversations"),
    );
  });

  it("goes back to the list by default, and to the agent's Conversations section when opened from it", async () => {
    search.current = new URLSearchParams();
    const first = render(<ConversationDetailPage />);
    await screen.findByRole("heading", { name: "Booking a visit" });
    expect(screen.getByRole("link", { name: /conversations.detail.breadcrumb/ })).toHaveAttribute(
      "href",
      "/organizations/acme/workspaces/sales/conversations",
    );
    first.unmount();

    search.current = new URLSearchParams("from=agent");
    render(<ConversationDetailPage />);
    await screen.findByRole("heading", { name: "Booking a visit" });
    // Catches «Indietro» dropping a reader opened from an agent into the workspace-wide list.
    expect(screen.getByRole("link", { name: /conversations.detail.breadcrumb/ })).toHaveAttribute(
      "href",
      "/organizations/acme/workspaces/sales/instances/bot-1?tab=conversations",
    );
    search.current = new URLSearchParams();
  });

  it("says so when the conversation has no messages", async () => {
    mockMessages.mockResolvedValue({ messages: [], total: 0, limit: 50, offset: 0, order: "desc" });

    await renderLoaded();

    expect(screen.getByText("conversations.detail.noMessages")).toBeInTheDocument();
  });

  describe("delete", () => {
    it("asks for confirmation and deletes nothing on cancel", async () => {
      const user = await renderLoaded();

      await chooseAction(user, "conversations.detail.deleteButton");
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("conversations.detail.deleteTitle")).toBeInTheDocument();
      expect(mockDelete).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole("button", { name: "common.cancel" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("deletes this conversation within its agent on confirm, then returns to the list", async () => {
      const user = await renderLoaded();

      await chooseAction(user, "conversations.detail.deleteButton");
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "common.delete" }));

      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith("/organizations/acme/workspaces/sales/conversations"),
      );
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledWith(CONVERSATION_ID, INSTANCE_ID);
    });

    it("stays on the page when the delete fails", async () => {
      mockDelete.mockRejectedValue(new Error("boom"));
      const user = await renderLoaded();

      await chooseAction(user, "conversations.detail.deleteButton");
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "common.delete" }),
      );

      await waitFor(() => expect(mockDelete).toHaveBeenCalled());
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe("rename", () => {
    it("saves a new title under the same id and shows it in place", async () => {
      const user = await renderLoaded();

      await chooseAction(user, "conversations.detail.renameButton");
      const dialog = await screen.findByRole("dialog");
      const titleInput = within(dialog).getByLabelText("conversations.detail.renameTitleLabel");
      expect(titleInput).toHaveValue("Booking a visit");
      expect(within(dialog).getByLabelText("conversations.detail.renameIdLabel")).toHaveValue(CONVERSATION_ID);

      await user.clear(titleInput);
      await user.type(titleInput, "  Visit on Tuesday  ");
      await user.click(within(dialog).getByRole("button", { name: "common.save" }));

      await screen.findByRole("heading", { name: "Visit on Tuesday" });
      expect(mockRename).toHaveBeenCalledWith(CONVERSATION_ID, INSTANCE_ID, {
        conversationId: CONVERSATION_ID,
        title: "Visit on Tuesday",
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("moves to the new address when the id changes", async () => {
      const user = await renderLoaded();

      await chooseAction(user, "conversations.detail.renameButton");
      const dialog = await screen.findByRole("dialog");
      const idInput = within(dialog).getByLabelText("conversations.detail.renameIdLabel");
      await user.clear(idInput);
      await user.type(idInput, "bot-1:telegram:43");
      await user.click(within(dialog).getByRole("button", { name: "common.save" }));

      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith(
          `/organizations/acme/workspaces/sales/conversations/${encodeURIComponent("bot-1:telegram:43")}`,
        ),
      );
      expect(mockRename).toHaveBeenCalledWith(CONVERSATION_ID, INSTANCE_ID, {
        conversationId: "bot-1:telegram:43",
        title: "Booking a visit",
      });
    });

    it("refuses an empty title without calling the engine", async () => {
      const user = await renderLoaded();

      await chooseAction(user, "conversations.detail.renameButton");
      const dialog = await screen.findByRole("dialog");
      await user.clear(within(dialog).getByLabelText("conversations.detail.renameTitleLabel"));
      await user.click(within(dialog).getByRole("button", { name: "common.save" }));

      expect(mockRename).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});
