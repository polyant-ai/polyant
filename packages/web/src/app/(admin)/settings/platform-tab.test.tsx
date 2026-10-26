// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSettings = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/lib/api", () => ({
  api: { platform: { settings: (...args: unknown[]) => mockSettings(...args), updateSettings: (...args: unknown[]) => mockUpdate(...args) } },
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

describe("PlatformTab — saving", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has one Save at the top, off until a value is edited, and sends the edit", async () => {
    mockSettings.mockResolvedValue({ settings: SETTINGS, effective: { ...SETTINGS, analyticsRetentionDays: 90, baseUrl: "http://x" } });
    mockUpdate.mockResolvedValue({ settings: { ...SETTINGS, analyticsRetentionDays: 30 }, effective: SETTINGS });
    render(<PlatformTab />);

    const save = await screen.findByRole("button", { name: "common.save" });
    // Catches a second Save at the foot of a long form, and one that is live with nothing changed.
    expect(screen.getAllByRole("button", { name: "common.save" })).toHaveLength(1);
    expect(save).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("settings.platform.analyticsRetentionDays"), "30");
    expect(save).toBeEnabled();
    await user.click(save);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ analyticsRetentionDays: 30 }));
  });
});
