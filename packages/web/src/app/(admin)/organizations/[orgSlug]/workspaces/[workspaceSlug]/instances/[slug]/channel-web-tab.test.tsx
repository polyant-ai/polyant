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

const { mockSecretsList, mockSecretsSet, mockInstanceUpdate, mockToastError, mockChannelsList, mockChannelsSet } = vi.hoisted(() => ({
  mockChannelsList: vi.fn(),
  mockChannelsSet: vi.fn(),
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
    channels: {
      list: (...a: unknown[]) => mockChannelsList(...a),
      set: (...a: unknown[]) => mockChannelsSet(...a),
    },
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
  mockChannelsList.mockResolvedValue({ channels: [] });
  mockChannelsSet.mockResolvedValue({ channel: null });
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

  describe("context fields", () => {
    it("saves the mapping the rows describe, trimmed and without blank rows", async () => {
      mockSecretsList.mockResolvedValue({ secrets: [{ key: "auth_api_key", configured: true }] });
      mockInstanceUpdate.mockResolvedValue({ instance: agent({ webContextFieldMapping: { phone: "phone" } }) });
      renderTab(agent({ webContextFieldMapping: {} }));

      await userEvent.click(screen.getByText("channels.tab.mappingAdd"));
      await userEvent.type(screen.getByLabelText("channels.tab.mappingStateKey"), " phone ");
      await userEvent.type(screen.getByLabelText("channels.tab.webContextMappingPath"), "phone");
      await userEvent.click(screen.getByText("channels.tab.mappingAdd"));
      await userEvent.click(screen.getByText("common.save"));

      await waitFor(() => expect(mockInstanceUpdate).toHaveBeenCalledWith("bot-1", {
        authEnabled: false,
        webContextFieldMapping: { phone: "phone" },
      }));
    });

    it("shows the key field once a field is mapped, even with authentication off", async () => {
      renderTab(agent({ authEnabled: false, webContextFieldMapping: { phone: "phone" } }));
      expect(screen.getByText("settings.tab.authApiKey")).toBeInTheDocument();
    });

    it("refuses to save a mapping with no key behind it", async () => {
      renderTab(agent({ webContextFieldMapping: {} }));
      await userEvent.click(screen.getByText("channels.tab.mappingAdd"));
      await userEvent.type(screen.getByLabelText("channels.tab.mappingStateKey"), "phone");
      await userEvent.type(screen.getByLabelText("channels.tab.webContextMappingPath"), "phone");
      await userEvent.click(screen.getByText("common.save"));

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("channels.tab.webContextKeyRequired"));
      expect(mockInstanceUpdate).not.toHaveBeenCalled();
    });

    it("is not dirty when the saved mapping is shown unchanged", async () => {
      renderTab(agent({ webContextFieldMapping: { phone: "phone", contact_id: "contactId" } }));
      await waitFor(() => expect(mockSecretsList).toHaveBeenCalled());
      expect(screen.queryByText("common.save")).not.toBeInTheDocument();
    });
  });

  describe("turning authentication off", () => {
    beforeEach(() => {
      mockInstanceUpdate.mockResolvedValue({ instance: agent({ authEnabled: false }) });
    });

    it("should_not_save_until_the_risk_is_accepted", async () => {
      renderTab(agent({ authEnabled: true }));
      await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));
      await userEvent.click(await screen.findByText("common.save"));

      expect(screen.getByText("channels.tab.webAuthOffDescription")).toBeInTheDocument();
      expect(mockInstanceUpdate).not.toHaveBeenCalled();

      await userEvent.click(screen.getByText("common.cancel"));
      expect(mockInstanceUpdate).not.toHaveBeenCalled();
    });

    it("should_save_authentication_off_once_the_risk_is_accepted", async () => {
      renderTab(agent({ authEnabled: true }));
      await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));
      await userEvent.click(await screen.findByText("common.save"));
      await userEvent.click(screen.getByText("channels.tab.webAuthOffAccept"));

      await waitFor(() =>
        expect(mockInstanceUpdate).toHaveBeenCalledWith(
          "bot-1",
          expect.objectContaining({ authEnabled: false }),
        ),
      );
    });

    it("should_not_ask_when_authentication_stays_on", async () => {
      renderTab(agent({ authEnabled: true }));
      mockSecretsList.mockResolvedValue({ secrets: [{ key: "auth_api_key", configured: true }] });
      await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));
      await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));

      expect(screen.queryByText("common.save")).not.toBeInTheDocument();
      expect(screen.queryByText("channels.tab.webAuthOffDescription")).not.toBeInTheDocument();
    });
  });

  it("should_generate_a_key_into_the_field_when_none_exists", async () => {
    renderTab(agent({ authEnabled: true }));
    await userEvent.click(await screen.findByText("channels.tab.webKeyGenerate"));

    const field = screen.getByPlaceholderText("settings.tab.authKeyPlaceholder") as HTMLInputElement;
    expect(field.value).toMatch(/^[0-9a-f]{64}$/);
    expect(field.type).toBe("text");
  });

  describe("the Web channel switch", () => {
    it("starts off when the agent has no web row, and is not dirty", async () => {
      renderTab(agent({ authEnabled: true }));
      const sw = await screen.findByLabelText("channels.tab.webEnabled");
      await waitFor(() => expect(sw).not.toBeDisabled());
      expect(sw).not.toBeChecked();
      expect(screen.queryByText("common.save")).not.toBeInTheDocument();
    });

    it("reads the stored state", async () => {
      mockChannelsList.mockResolvedValue({ channels: [{ channelType: "web", enabled: true, config: {} }] });
      renderTab(agent({ authEnabled: true }));
      await waitFor(() => expect(screen.getByLabelText("channels.tab.webEnabled")).toBeChecked());
    });

    it("saves the key, then the agent, then switches the channel on", async () => {
      const order: string[] = [];
      mockSecretsSet.mockImplementation(async () => { order.push("secret"); return { secrets: [] }; });
      mockInstanceUpdate.mockImplementation(async () => { order.push("agent"); return { instance: agent({ authEnabled: true }) }; });
      mockChannelsSet.mockImplementation(async () => { order.push("channel"); return { channel: null }; });
      const onWebEnabledChange = vi.fn();

      render(
        <PageActionsProvider>
          <ChannelWebTab instance={agent({ authEnabled: true })} onUpdate={vi.fn()} onWebEnabledChange={onWebEnabledChange} />
          <SaveButton />
        </PageActionsProvider>,
      );
      const sw = await screen.findByLabelText("channels.tab.webEnabled");
      await waitFor(() => expect(sw).not.toBeDisabled());
      await userEvent.click(sw);
      await userEvent.click(await screen.findByText("channels.tab.webKeyGenerate"));
      await userEvent.click(screen.getByText("common.save"));

      await waitFor(() => expect(order).toEqual(["secret", "agent", "channel"]));
      expect(mockChannelsSet).toHaveBeenCalledWith("bot-1", "web", {}, true);
      expect(onWebEnabledChange).toHaveBeenLastCalledWith(true);
    });

    it("does not switch Web on while authentication is on and no key exists", async () => {
      renderTab(agent({ authEnabled: true }));
      const sw = await screen.findByLabelText("channels.tab.webEnabled");
      await waitFor(() => expect(sw).not.toBeDisabled());
      await userEvent.click(sw);
      await userEvent.click(screen.getByText("common.save"));

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("channels.tab.webAuthKeyRequired"));
      expect(mockChannelsSet).not.toHaveBeenCalled();
    });

    it("asks for the risk notice before saving Web on with authentication turned off", async () => {
      renderTab(agent({ authEnabled: true }));
      const sw = await screen.findByLabelText("channels.tab.webEnabled");
      await waitFor(() => expect(sw).not.toBeDisabled());
      await userEvent.click(sw);
      await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));
      await userEvent.click(screen.getByText("common.save"));

      expect(screen.getByText("channels.tab.webAuthOffDescription")).toBeInTheDocument();
      expect(mockChannelsSet).not.toHaveBeenCalled();
    });

    it("does not call the channel API when only authentication changed", async () => {
      mockSecretsList.mockResolvedValue({ secrets: [{ key: "auth_api_key", configured: true }] });
      mockInstanceUpdate.mockResolvedValue({ instance: agent({ authEnabled: false }) });
      renderTab(agent({ authEnabled: true }));
      await waitFor(() => expect(mockChannelsList).toHaveBeenCalled());
      await userEvent.click(screen.getByLabelText("settings.tab.authEnabled"));
      await userEvent.click(await screen.findByText("common.save"));
      await userEvent.click(screen.getByText("channels.tab.webAuthOffAccept"));

      await waitFor(() => expect(mockInstanceUpdate).toHaveBeenCalled());
      expect(mockChannelsSet).not.toHaveBeenCalled();
    });
  });
});
