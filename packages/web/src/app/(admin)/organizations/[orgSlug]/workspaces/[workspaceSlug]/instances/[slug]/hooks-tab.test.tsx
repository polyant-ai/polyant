// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HooksTab } from "./hooks-tab";
import type { HookFunctionInfo, InstanceHook } from "@/lib/api";

const { mockHookDelete, mockHooksList, mockHookFunctions, mockHookCreate, mockHookUpdate, mockSecretsList, mockSecretsSet, mockRequiredSecrets } = vi.hoisted(() => ({
  mockHookDelete: vi.fn(),
  mockHooksList: vi.fn(),
  mockHookCreate: vi.fn(),
  mockHookUpdate: vi.fn(),
  mockHookFunctions: vi.fn(),
  mockSecretsList: vi.fn(),
  mockSecretsSet: vi.fn(),
  mockRequiredSecrets: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api", () => ({
  api: {
    hooks: {
      list: (...a: unknown[]) => mockHooksList(...a),
      functions: (...a: unknown[]) => mockHookFunctions(...a),
      create: (...a: unknown[]) => mockHookCreate(...a),
      update: (...a: unknown[]) => mockHookUpdate(...a),
      delete: (...a: unknown[]) => mockHookDelete(...a),
    },
    tools: { requiredSecrets: (...a: unknown[]) => mockRequiredSecrets(...a) },
    secrets: {
      list: (...a: unknown[]) => mockSecretsList(...a),
      set: (...a: unknown[]) => mockSecretsSet(...a),
      delete: vi.fn(),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
  isForbidden: () => false,
}));

function hook(functionName: string, enabled: boolean): InstanceHook {
  return {
    id: functionName,
    event: "response_generated",
    actionType: "function",
    actionConfig: { functionName },
    enabled,
    position: 0,
    timeoutMs: 10000,
    createdAt: "",
    updatedAt: "",
  };
}

const CATALOG: HookFunctionInfo[] = [
  {
    name: "moderate",
    description: "",
    mutatesResponse: true,
    requiredSecrets: [{ key: "moderation_api_key", type: "text", sensitive: true, label: "Moderation API key", description: "Key of the moderation service." }],
  },
  {
    name: "translate",
    description: "",
    mutatesResponse: true,
    requiredSecrets: [{ key: "translate_api_key", type: "text", sensitive: true, label: "Translation API key" }],
  },
];

describe("HooksTab — parameters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHooksList.mockResolvedValue({ hooks: [hook("moderate", true), hook("translate", false)] });
    mockHookFunctions.mockResolvedValue({ hookFunctions: CATALOG });
    mockSecretsList.mockResolvedValue({ secrets: [] });
    mockRequiredSecrets.mockResolvedValue({ requiredSecrets: [] });
    mockSecretsSet.mockResolvedValue({ secrets: [{ key: "moderation_api_key", configured: true }] });
  });

  it("marks the enabled hook whose key is missing, not the disabled one", async () => {
    render(<HooksTab slug="agent-1" />);

    expect(await screen.findByText("hooks.paramsMissing")).toBeInTheDocument();
    expect(screen.getAllByText("hooks.paramsMissing")).toHaveLength(1);
    expect(screen.queryByText("Moderation API key")).not.toBeInTheDocument();
  });

  it("opens a hook in a side sheet with its own keys, and one Save writes them", async () => {
    const user = userEvent.setup();
    render(<HooksTab slug="agent-1" />);

    // The rows follow the hooks' order: `moderate` first.
    const [moderateRow] = await screen.findAllByRole("button", { name: "hooks.open" });
    await user.click(moderateRow);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Moderation API key")).toBeInTheDocument();
    expect(within(sheet).getByText("Key of the moderation service.")).toBeInTheDocument();
    expect(within(sheet).queryByText("Translation API key")).not.toBeInTheDocument();

    const save = within(sheet).getByRole("button", { name: "common.save" });
    expect(save).toBeDisabled();
    await user.type(within(sheet).getByPlaceholderText("settings.tab.keyPlaceholder"), "mod-123");
    await user.click(save);

    await waitFor(() =>
      expect(mockSecretsSet).toHaveBeenCalledWith("agent-1", [{ key: "moderation_api_key", value: "mod-123" }]),
    );
    expect(mockHookUpdate).not.toHaveBeenCalled();
  });

  it("asks before closing a sheet with unsaved changes, and discarding writes nothing", async () => {
    const user = userEvent.setup();
    render(<HooksTab slug="agent-1" />);

    const [moderateRow] = await screen.findAllByRole("button", { name: "hooks.open" });
    await user.click(moderateRow);
    const sheet = await screen.findByRole("dialog");
    await user.type(within(sheet).getByPlaceholderText("settings.tab.keyPlaceholder"), "mod-123");
    await user.click(within(sheet).getByRole("button", { name: "common.cancel" }));

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("unsavedChanges.title")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "unsavedChanges.discard" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockSecretsSet).not.toHaveBeenCalled();
    expect(mockHookUpdate).not.toHaveBeenCalled();
  });

  it("lists hooks in execution order: by event, then position, not by name", async () => {
    mockHooksList.mockResolvedValue({
      hooks: [
        { ...hook("zz-late", true), event: "response_sent", position: 0 },
        { ...hook("bb-second", true), event: "message_received", position: 2 },
        { ...hook("aa-first", true), event: "message_received", position: 1 },
      ],
    });
    render(<HooksTab slug="agent-1" />);

    const rows = await screen.findAllByRole("button", { name: "hooks.open" });
    expect(rows.map((r) => r.textContent)).toEqual(["aa-first", "bb-second", "zz-late"]);
  });

  it("filters the hooks by function name or event", async () => {
    const user = userEvent.setup();
    render(<HooksTab slug="agent-1" />);
    await screen.findAllByRole("button", { name: "hooks.open" });

    await user.type(screen.getByRole("searchbox"), "transl");

    expect(screen.getAllByRole("button", { name: "hooks.open" }).map((r) => r.textContent)).toEqual(["translate"]);
  });

  it("switches a hook from the Active column without opening it, and takes it back when the engine refuses", async () => {
    const user = userEvent.setup();
    mockHookUpdate.mockRejectedValue(new Error("refused"));
    render(<HooksTab slug="agent-1" />);
    await screen.findAllByRole("button", { name: "hooks.open" });

    const sw = screen.getAllByRole("switch", { name: "common.activeNamed" })[1];
    expect(sw).not.toBeChecked();
    await user.click(sw);

    await waitFor(() => expect(mockHookUpdate).toHaveBeenCalledWith("agent-1", "translate", { enabled: true }));
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deletes a hook only from its drawer, and only after confirming", async () => {
    const user = userEvent.setup();
    render(<HooksTab slug="agent-1" />);
    await screen.findAllByRole("button", { name: "hooks.open" });
    expect(screen.queryByRole("button", { name: "common.delete" })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "hooks.open" })[0]);
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "common.delete" }));

    const confirm = await screen.findByRole("alertdialog");
    expect(mockHookDelete).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "common.delete" }));
    await waitFor(() => expect(mockHookDelete).toHaveBeenCalledWith("agent-1", "moderate"));
  });

  it("offers Add, not Save, and keeps it off until a function is chosen", async () => {
    const user = userEvent.setup();
    render(<HooksTab slug="agent-1" />);

    await user.click(await screen.findByRole("button", { name: "hooks.add" }));
    const dialog = await screen.findByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "common.add" });
    expect(add).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "common.save" })).not.toBeInTheDocument();

    await user.click(within(dialog).getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "translate" }));
    expect(add).toBeEnabled();
  });

  it("titles a hook's drawer with its function name in the ordinary title font", async () => {
    const user = userEvent.setup();
    render(<HooksTab slug="agent-1" />);
    await user.click((await screen.findAllByRole("button", { name: "hooks.open" }))[0]);
    const heading = within(await screen.findByRole("dialog")).getByRole("heading", { name: "moderate" });
    expect(heading.className).not.toMatch(/font-mono/);
    expect(heading.querySelector(".font-mono")).toBeNull();
  });

  it("asks for the chosen function's keys while adding a hook, and writes them with it", async () => {
    const user = userEvent.setup();
    mockHookCreate.mockResolvedValue({});
    render(<HooksTab slug="agent-1" />);

    await user.click(await screen.findByRole("button", { name: "hooks.add" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Translation API key")).not.toBeInTheDocument();

    await user.click(within(dialog).getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "translate" }));
    await user.type(within(dialog).getByPlaceholderText("settings.tab.keyPlaceholder"), "tr-9");
    await user.click(within(dialog).getByRole("button", { name: "common.add" }));

    await waitFor(() =>
      expect(mockSecretsSet).toHaveBeenCalledWith("agent-1", [{ key: "translate_api_key", value: "tr-9" }]),
    );
    expect(mockHookCreate).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ actionConfig: { functionName: "translate" } }),
    );
  });
});
