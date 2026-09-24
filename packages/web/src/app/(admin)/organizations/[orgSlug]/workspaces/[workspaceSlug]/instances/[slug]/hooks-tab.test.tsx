// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HooksTab } from "./hooks-tab";
import type { HookFunctionInfo, InstanceHook } from "@/lib/api";

const { mockHooksList, mockHookFunctions, mockSecretsList, mockSecretsSet, mockRequiredSecrets } = vi.hoisted(() => ({
  mockHooksList: vi.fn(),
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
    hooks: { list: (...a: unknown[]) => mockHooksList(...a), functions: (...a: unknown[]) => mockHookFunctions(...a) },
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

  it("shows the keys of the enabled hooks only, with who asks for them", async () => {
    render(<HooksTab slug="agent-1" />);

    expect(await screen.findByText("Moderation API key")).toBeInTheDocument();
    expect(screen.getByText("Key of the moderation service.")).toBeInTheDocument();
    expect(screen.queryByText("Translation API key")).not.toBeInTheDocument();
  });

  it("writes a typed key with the section's own button", async () => {
    const user = userEvent.setup();
    render(<HooksTab slug="agent-1" />);

    await screen.findByText("Moderation API key");
    const save = screen.getByRole("button", { name: "tools.paramsSave" });
    expect(save).toBeDisabled();
    await user.type(screen.getByPlaceholderText("settings.tab.keyPlaceholder"), "mod-123");
    await user.click(save);

    await waitFor(() =>
      expect(mockSecretsSet).toHaveBeenCalledWith("agent-1", [{ key: "moderation_api_key", value: "mod-123" }]),
    );
  });
});
