// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The scheduled triggers of an agent: what is listed, what a new task sends,
 * the Active switch on the row, and run now / delete, which live in the task's
 * drawer, the delete only after confirmation.
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

/** Opens a task's drawer from its row and returns it. */
async function openTask(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog");
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

  it("draws the status as the shared badge without an icon, and an empty channel as an em dash", async () => {
    await renderLoaded();
    const badge = screen.getByText("scheduledTasks.statusActive");
    expect(badge.querySelector("svg")).toBeNull();
    const row = screen.getByText("Daily digest").closest("tr") as HTMLElement;
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(row).queryByText("-")).not.toBeInTheDocument();
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
    await user.click(within(dialog).getByRole("button", { name: "common.add" }));

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

  it("keeps Add off until the task has a name and a prompt", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole("button", { name: "scheduledTasks.newTask" }));
    const dialog = await screen.findByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "common.add" });
    expect(add).toBeDisabled();

    await user.type(within(dialog).getByPlaceholderText("Daily briefing"), "Morning check");
    expect(add).toBeDisabled();
    await user.type(within(dialog).getByPlaceholderText("scheduledTasks.form.promptPlaceholder"), "Check the inbox");
    expect(add).toBeEnabled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("offers no delete or run-now on the row, only in the task's drawer", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    expect(screen.queryByRole("button", { name: "common.delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "scheduledTasks.runNow" })).not.toBeInTheDocument();

    const drawer = await openTask(user, "Weekly report");

    expect(within(drawer).getByRole("button", { name: "common.delete" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "scheduledTasks.runNow" })).toBeInTheDocument();
  });

  it("does not delete a task when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const drawer = await openTask(user, "Weekly report");
    await user.click(within(drawer).getByRole("button", { name: "common.delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("scheduledTasks.deleteTitle");
    await user.click(within(confirm).getByRole("button", { name: "common.cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes exactly the confirmed task", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const drawer = await openTask(user, "Weekly report");
    await user.click(within(drawer).getByRole("button", { name: "common.delete" }));
    expect(mockDelete).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "common.delete" }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("bot-1", "task-2"));
    expect(mockDelete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("scheduledTasks.deleted"));
  });

  it("pauses an enabled task and resumes a paused one from the Active switch, without opening the drawer", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const [digestSwitch, reportSwitch] = screen.getAllByRole("switch");

    await user.click(digestSwitch);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("bot-1", "task-1", { enabled: false }));

    await user.click(reportSwitch);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("bot-1", "task-2", { enabled: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a paused task's switch off when the engine refuses to resume it", async () => {
    const user = userEvent.setup();
    mockUpdate.mockRejectedValue(new Error("refused"));
    await renderLoaded();
    const reportSwitch = screen.getAllByRole("switch")[1];

    await user.click(reportSwitch);

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("scheduledTasks.toggleFailed"));
    await waitFor(() => expect(reportSwitch).not.toBeChecked());
  });

  it("finds a task by its name, description or schedule", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(screen.getByRole("searchbox"), "7 days");

    expect(screen.getByText("Weekly report")).toBeInTheDocument();
    expect(screen.queryByText("Daily digest")).not.toBeInTheDocument();
  });

  it("lists tasks by name, whatever order the engine answers in", async () => {
    mockList.mockResolvedValue({ tasks: [REPORT, DIGEST] });
    await renderLoaded();

    const names = screen.getAllByRole("button", { name: /Daily digest|Weekly report/ }).map((b) => b.textContent);
    expect(names).toEqual(["Daily digest", "Weekly report"]);
  });

  it("runs a task now from its drawer and reports the engine's answer", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const drawer = await openTask(user, "Weekly report");
    await user.click(within(drawer).getByRole("button", { name: "scheduledTasks.runNow" }));

    await waitFor(() => expect(mockRun).toHaveBeenCalledWith("bot-1", "task-2"));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("Run queued"));
  });

  it("edits a task through update, keeping its schedule", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const dialog = await openTask(user, "Daily digest");
    // The drawer is titled with the task's own name and describes its schedule.
    expect(dialog).toHaveTextContent("Daily digest");
    expect(dialog).toHaveTextContent("every day at 09:00");
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
