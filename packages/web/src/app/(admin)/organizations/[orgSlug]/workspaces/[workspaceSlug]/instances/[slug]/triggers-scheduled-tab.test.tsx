// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The scheduled triggers of an agent: what is listed, what a new task sends,
 * and the row actions — pause/resume, run now, and a delete that only happens
 * after confirmation.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScheduledTask } from "@/lib/api";

const { mockList, mockCreate, mockUpdate, mockDelete, mockRun, mockToast } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockRun: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  api: {
    scheduledTasks: {
      list: mockList,
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
      run: mockRun,
    },
  },
  getUserErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

// A stable `t`, as the real provider gives: the list loader depends on it, and
// a new function per render would reload the list on every keystroke.
const i18n = vi.hoisted(() => ({ t: (k: string) => k, locale: "en" }));
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => i18n }));
vi.mock("sonner", () => ({ toast: mockToast }));

import { TriggersScheduledTab } from "./triggers-scheduled-tab";

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Daily digest",
    description: "Morning summary",
    schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    scheduleHuman: "every day at 09:00",
    prompt: "Summarise yesterday",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    lastConversationId: null,
    consecutiveErrors: 0,
    totalRuns: 0,
    deleteAfterRun: false,
    maxRetries: 0,
    maxRunMs: null,
    outboundChannel: null,
    outboundTarget: null,
    keepHistory: false,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}

const DIGEST = task();
const REPORT = task({
  id: "task-2",
  name: "Weekly report",
  description: null,
  scheduleHuman: "every 7 days",
  enabled: false,
});

/**
 * The row actions are icon-only buttons whose names live in hover tooltips,
 * so they have no accessible name; they are taken by position within the row:
 * pause/resume, run now, edit, delete.
 */
function rowActions(name: string) {
  const row = screen.getByText(name).closest("tr") as HTMLElement;
  const [toggle, runNow, edit, remove] = within(row).getAllByRole("button");
  return { toggle, runNow, edit, remove };
}

async function renderLoaded() {
  render(<TriggersScheduledTab slug="bot-1" />);
  await screen.findByText("Daily digest");
}

describe("TriggersScheduledTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ tasks: [DIGEST, REPORT] });
    mockCreate.mockResolvedValue({ task: DIGEST });
    mockUpdate.mockResolvedValue({ task: DIGEST });
    mockDelete.mockResolvedValue({ deleted: true });
    mockRun.mockResolvedValue({ message: "Run queued" });
  });

  it("lists the agent's tasks with their schedule and paused state", async () => {
    await renderLoaded();

    expect(mockList).toHaveBeenCalledWith("bot-1");
    expect(screen.getByText("Weekly report")).toBeInTheDocument();
    expect(screen.getByText("every day at 09:00")).toBeInTheDocument();
    expect(screen.getByText("scheduledTasks.statusActive")).toBeInTheDocument();
    expect(screen.getByText("scheduledTasks.statusPaused")).toBeInTheDocument();
  });

  it("shows the empty state when the agent has no task", async () => {
    mockList.mockResolvedValue({ tasks: [] });
    render(<TriggersScheduledTab slug="bot-1" />);

    expect(await screen.findByText("scheduledTasks.empty")).toBeInTheDocument();
  });

  it("creates a cron task with the fields typed in the dialog", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ tasks: [] });
    render(<TriggersScheduledTab slug="bot-1" />);
    await screen.findByText("scheduledTasks.empty");

    await user.click(screen.getByRole("button", { name: "scheduledTasks.newTask" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("Daily briefing"), "Morning check");
    await user.type(within(dialog).getByPlaceholderText("scheduledTasks.form.promptPlaceholder"), "Check the inbox");
    await user.type(within(dialog).getByPlaceholderText("0 9 * * 1-5"), "0 8 * * 1-5");
    const timezone = within(dialog).getByPlaceholderText("UTC");
    await user.clear(timezone);
    await user.type(timezone, "Europe/Rome");
    await user.click(within(dialog).getByRole("button", { name: "scheduledTasks.form.create" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith("bot-1", {
      name: "Morning check",
      prompt: "Check the inbox",
      schedule: { type: "cron", expression: "0 8 * * 1-5", timezone: "Europe/Rome" },
      description: undefined,
      deleteAfterRun: false,
      outboundChannel: null,
      outboundTarget: null,
      keepHistory: false,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("refuses to create a task without a name or prompt", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole("button", { name: "scheduledTasks.newTask" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "scheduledTasks.form.create" }));

    expect(mockToast.error).toHaveBeenCalledWith("scheduledTasks.validation.required");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not delete a task when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(rowActions("Weekly report").remove);
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("scheduledTasks.deleteTitle");
    await user.click(within(confirm).getByRole("button", { name: "common.cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes exactly the confirmed task", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(rowActions("Weekly report").remove);
    expect(mockDelete).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "common.delete" }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("bot-1", "task-2"));
    expect(mockDelete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("scheduledTasks.deleted"));
  });

  it("pauses an enabled task and resumes a paused one", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(rowActions("Daily digest").toggle);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("bot-1", "task-1", { enabled: false }));

    await user.click(rowActions("Weekly report").toggle);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("bot-1", "task-2", { enabled: true }));
  });

  it("runs a task now and reports the engine's answer", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(rowActions("Weekly report").runNow);

    await waitFor(() => expect(mockRun).toHaveBeenCalledWith("bot-1", "task-2"));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("Run queued"));
  });

  it("edits a task through update, keeping its schedule", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(rowActions("Daily digest").edit);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("scheduledTasks.editTitle");
    const name = within(dialog).getByDisplayValue("Daily digest");
    await user.clear(name);
    await user.type(name, "Daily digest v2");
    await user.click(within(dialog).getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(
      "bot-1",
      "task-1",
      expect.objectContaining({
        name: "Daily digest v2",
        prompt: "Summarise yesterday",
        schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      }),
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
