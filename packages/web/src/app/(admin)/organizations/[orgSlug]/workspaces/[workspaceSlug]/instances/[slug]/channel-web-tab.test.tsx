// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelWebTab } from "./channel-web-tab";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
import type { Instance } from "@/lib/api";

/** Stands in for the page header's save button, which is where this tab's lives. */
function SaveButton() {
  const { saveAction } = usePageActions();
  if (!saveAction?.isDirty) return null;
  return <button onClick={() => saveAction.onSave()}>common.save</button>;
}

const { mockSecretsList, mockSecretsSet, mockInstanceUpdate, mockToastError } = vi.hoisted(() => ({
  mockSecretsList: vi.fn(),
  mockSecretsSet: vi.fn(),
  mockInstanceUpdate: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    secrets: {
      list: (...a: unknown[]) => mockSecretsList(...a),
      set: (...a: unknown[]) => mockSecretsSet(...a),
      delete: vi.fn(),
    },
    instances: { update: (...a: unknown[]) => mockInstanceUpdate(...a) },
  },
  getUserErrorMessage: (_e: unknown, d: string) => d,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => mockToastError(...a) },
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en", setLocale: vi.fn() }),
}));

function agent(overrides: Partial<Instance> = {}): Instance {
  return { slug: "bot-1", authEnabled: false, ...overrides } as Instance;
}

function renderTab(instance: Instance, onUpdate = vi.fn()) {
  return render(
    <PageActionsProvider>
      <ChannelWebTab instance={instance} onUpdate={onUpdate} />
      <SaveButton />
    </PageActionsProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSecretsList.mockResolvedValue({ secrets: [] });
  mockSecretsSet.mockResolvedValue({ secrets: [] });
  mockInstanceUpdate.mockResolvedValue({ instance: agent({ authEnabled: true }) });
});

describe("ChannelWebTab", () => {
  it("should_hide_the_key_field_until_authentication_is_required", async () => {
    renderTab(agent({ authEnabled: false }));

    expect(screen.queryByText("settings.tab.authApiKey")).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));

    expect(screen.getByText("settings.tab.authApiKey")).toBeInTheDocument();
  });

  /**
   * The switch governs EVERY api route of this agent — the OpenAI-compatible
   * endpoint, the native stream and the CLI's alias — not the one whose name a
   * reader happens to remember. "Off" opens all of them, so the copy has to say
   * so rather than leaving an operator to infer it from an endpoint list.
   */
  it("should_say_the_switch_covers_all_api_access", () => {
    renderTab(agent());

    expect(screen.getByText("channels.tab.webAuthHelp")).toBeInTheDocument();
  });

  /**
   * Key BEFORE the flag. Persisting the switch first and then failing to write
   * the key leaves an agent that refuses every caller, which is a worse state
   * than the one the operator was trying to leave.
   */
  it("should_write_the_key_before_persisting_the_switch", async () => {
    const order: string[] = [];
    mockSecretsSet.mockImplementation(async () => {
      order.push("secret");
      return { secrets: [] };
    });
    mockInstanceUpdate.mockImplementation(async () => {
      order.push("flag");
      return { instance: agent({ authEnabled: true }) };
    });

    renderTab(agent({ authEnabled: false }));
    await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));
    await userEvent.type(screen.getByPlaceholderText("settings.tab.authKeyPlaceholder"), "k-1");
    await userEvent.click(screen.getByText("common.save"));

    await waitFor(() => expect(order).toEqual(["secret", "flag"]));
  });

  it("should_not_persist_the_switch_when_the_key_write_fails", async () => {
    mockSecretsSet.mockRejectedValue(new Error("boom"));

    renderTab(agent({ authEnabled: false }));
    await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));
    await userEvent.type(screen.getByPlaceholderText("settings.tab.authKeyPlaceholder"), "k-1");
    await userEvent.click(screen.getByText("common.save"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockInstanceUpdate).not.toHaveBeenCalled();
  });
});
