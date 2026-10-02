// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSettings = vi.fn();

vi.mock("@/lib/api", () => ({
  api: { platform: { settings: (...args: unknown[]) => mockSettings(...args), updateSettings: vi.fn() } },
  PLATFORM_SETTING_NUMBERS: [
    "analyticsRetentionDays",
    "sseMaxConnections",
    "sseMaxConnectionsPerUser",
    "throttleTtlMs",
    "throttleLimit",
    "agentCallTimeoutMs",
    "mcpConnectTimeoutMs",
    "schedulerOrphanGraceMs",
    "schedulerDefaultMaxRunMs",
  ],
  getUserErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PlatformTab } from "./platform-tab";

const SETTINGS = {
  analyticsRetentionDays: null,
  sseMaxConnections: null,
  sseMaxConnectionsPerUser: null,
  throttleTtlMs: null,
  throttleLimit: null,
  agentCallTimeoutMs: null,
  mcpConnectTimeoutMs: null,
  schedulerOrphanGraceMs: null,
  schedulerDefaultMaxRunMs: null,
  baseUrl: null,
};

describe("PlatformTab — a failed load", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the reason and a retry instead of an endless skeleton, and the retry loads the form", async () => {
    mockSettings.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      settings: SETTINGS,
      effective: { ...SETTINGS, analyticsRetentionDays: 90, baseUrl: "http://localhost:3000" },
    });

    render(<PlatformTab />);

    expect(await screen.findByRole("alert")).toHaveTextContent("common.loadFailed");
    await userEvent.setup().click(screen.getByRole("button", { name: "common.retry" }));

    expect(await screen.findByText("settings.platform.title")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockSettings).toHaveBeenCalledTimes(2);
  });
});
