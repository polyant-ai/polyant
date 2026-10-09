// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The behaviour parameters (Parametri): what the engine puts in front of the
 * model each turn. Pinned: the section reads nothing it does not render, and
 * the page's Save writes the parameters through the agent's update.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { SettingsTab } from "./settings-tab";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
import type { Instance } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  models: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/lib/api", () => ({
  api: { instances: { update: mocks.update }, models: { list: mocks.models } },
  getUserErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

function SaveButton() {
  const { saveAction } = usePageActions();
  if (!saveAction?.isDirty) return null;
  return <button onClick={() => saveAction.onSave()}>common.save</button>;
}

function renderWithProvider(ui: ReactElement) {
  return render(
    <PageActionsProvider>
      {ui}
      <SaveButton />
    </PageActionsProvider>,
  );
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "test-instance",
    name: "Test Instance",
    status: "active",
    stateInPromptEnabled: false,
    datetimeInjectionEnabled: true,
    datetimeTimezone: null,
    datetimeLocale: null,
    dedupSimilarityThreshold: null,
    messageSoftDebounceMs: null,
    messageTypingDelayMs: null,
    messageMaxRestarts: null,
    toolResultsInHistoryEnabled: false,
    debugEnabled: false,
    ...overrides,
  } as Instance;
}

/** The debug switch, by its unique help text. */
function debugSwitch(): HTMLElement {
  const row = screen.getByText("settings.tab.debugHelp").closest("div")?.parentElement;
  return within(row as HTMLElement).getByRole("switch");
}

describe("SettingsTab (behaviour parameters)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the parameters and reads nothing it does not show", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} />);
    expect(screen.getByText("settings.tab.params")).toBeInTheDocument();
    expect(mocks.models).not.toHaveBeenCalled();
    expect(screen.queryByText("common.save")).not.toBeInTheDocument();
  });

  it("saves a changed parameter through the agent's update", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const updated = makeInstance({ debugEnabled: true });
    mocks.update.mockResolvedValueOnce({ instance: updated });
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} />);

    await user.click(debugSwitch());
    await user.click(screen.getByText("common.save"));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("test-instance", expect.objectContaining({ debugEnabled: true })),
    );
    expect(onUpdate).toHaveBeenCalledWith(updated);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("settings.tab.saved");
  });

  it("hands an emptied override back to the deployment default as null", async () => {
    const user = userEvent.setup();
    mocks.update.mockResolvedValueOnce({ instance: makeInstance() });
    renderWithProvider(<SettingsTab instance={makeInstance({ datetimeTimezone: "Europe/Rome" })} onUpdate={vi.fn()} />);

    await user.clear(screen.getByLabelText("settings.tab.datetimeTimezone"));
    await user.click(screen.getByText("common.save"));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("test-instance", expect.objectContaining({ datetimeTimezone: null })),
    );
  });
});
