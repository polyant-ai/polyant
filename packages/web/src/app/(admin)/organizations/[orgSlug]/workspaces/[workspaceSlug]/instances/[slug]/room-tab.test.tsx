// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoomTab } from "./room-tab";

const roomGetMock = vi.fn();
const eventSourcesListMock = vi.fn();
const roomBacklogMock = vi.fn();
const roomActivityMock = vi.fn();
const roomUpsertMock = vi.fn();

// Captures the latest top-bar save registration so assertions can read
// isDirty/saving and invoke onSave without rendering the page header.
const lastSaveAction = vi.hoisted(() => ({
  current: null as null | { isDirty: boolean; saving: boolean; onSave: () => void | Promise<void> },
}));
vi.mock("./page-actions-context", () => ({
  usePageSaveAction: (a: { isDirty: boolean; saving: boolean; onSave: () => void | Promise<void> }) => {
    lastSaveAction.current = a;
  },
  usePageActions: vi.fn(() => ({ saveAction: null, setSaveAction: vi.fn() })),
  PageActionsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/lib/api", () => ({
  api: {
    room: {
      get: (...args: unknown[]) => roomGetMock(...args),
      backlog: (...args: unknown[]) => roomBacklogMock(...args),
      activity: (...args: unknown[]) => roomActivityMock(...args),
      upsert: (...args: unknown[]) => roomUpsertMock(...args),
      delete: vi.fn(),
    },
    eventSources: {
      list: (...args: unknown[]) => eventSourcesListMock(...args),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      rotateToken: vi.fn(),
      createDefinition: vi.fn(),
      updateDefinition: vi.fn(),
      deleteDefinition: vi.fn(),
    },
  },
  getUserErrorMessage: vi.fn((_err: unknown, fallback: string) => fallback),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CONFIGURED_ROOM = {
  configured: true,
  id: "room-1",
  enabled: true,
  prompt: "",
  outboundChannel: "slack",
  outboundTarget: "#general",
  evalIntervalMinutes: 5,
};

describe("RoomTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSaveAction.current = null;
    eventSourcesListMock.mockResolvedValue([]);
    roomBacklogMock.mockResolvedValue({ events: [], total: 0 });
    roomActivityMock.mockResolvedValue([]);
    roomUpsertMock.mockResolvedValue({});
  });

  it("renders the new-room state when the API says the room is not configured", async () => {
    roomGetMock.mockResolvedValue({ configured: false });

    render(<RoomTab slug="demo" />);

    await waitFor(() => {
      expect(screen.getByText("room.config.title")).toBeInTheDocument();
    });

    expect(screen.queryByText("room.backlog.title")).not.toBeInTheDocument();
    expect(roomBacklogMock).not.toHaveBeenCalled();
    expect(roomActivityMock).not.toHaveBeenCalled();
  });

  it("renders the room prompt textarea with a placeholder", async () => {
    roomGetMock.mockResolvedValue(CONFIGURED_ROOM);

    render(<RoomTab slug="demo" />);

    await waitFor(() => {
      expect(screen.getByText("room.config.title")).toBeInTheDocument();
    });

    const promptTextarea = screen.getByPlaceholderText("room.config.promptPlaceholder");
    expect(promptTextarea).toBeInTheDocument();
  });

  // NOTE: the event-sources + definitions UI moved from RoomTab to
  // TriggersWebhooksTab during the triggers refactor.  The legacy test
  // that lived here ("shows help text in the add-definition form") was
  // tied to the old RoomTab structure and has been replaced by a dedicated
  // test on TriggersWebhooksTab.

  it("registers a header save action that is not dirty until the form changes", async () => {
    roomGetMock.mockResolvedValue(CONFIGURED_ROOM);

    render(<RoomTab slug="demo" />);

    await waitFor(() => {
      expect(screen.getByText("room.config.title")).toBeInTheDocument();
    });

    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("marks dirty and upserts the room config when the header save fires", async () => {
    const user = userEvent.setup();
    roomGetMock.mockResolvedValue(CONFIGURED_ROOM);

    render(<RoomTab slug="demo" />);

    await waitFor(() => {
      expect(screen.getByText("room.config.title")).toBeInTheDocument();
    });

    const promptTextarea = screen.getByPlaceholderText("room.config.promptPlaceholder");
    await user.type(promptTextarea, "hello");

    expect(lastSaveAction.current?.isDirty).toBe(true);

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(roomUpsertMock).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({ prompt: "hello" }),
      );
    });
  });
});
