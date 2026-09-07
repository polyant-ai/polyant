// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillEnvDialog } from "./skill-env-dialog";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params) {
        let result = key;
        for (const [k, v] of Object.entries(params)) {
          result = result.replace(`{${k}}`, String(v));
        }
        return result;
      }
      return key;
    },
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

const getEnvMock = vi.fn();
const setEnvMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    skills: {
      getEnv: (...args: unknown[]) => getEnvMock(...args),
      setEnv: (...args: unknown[]) => setEnvMock(...args),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Fixtures ────────────────────────────────────────────────────────

const envData = [
  {
    key: "API_KEY",
    value: "",
    sensitive: true,
    configured: false,
    description: "The API key for the service",
  },
  {
    key: "BASE_URL",
    value: "https://example.com",
    sensitive: false,
    configured: true,
    description: "Base URL of the service",
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

function renderDialog(
  props: Partial<React.ComponentProps<typeof SkillEnvDialog>> = {},
) {
  const defaults = {
    open: true,
    onOpenChange: vi.fn(),
    slug: "test-instance",
    skillName: "my-skill",
    onSaved: vi.fn(),
  };
  return {
    ...render(<SkillEnvDialog {...defaults} {...props} />),
    defaults,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("SkillEnvDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders title with skill name", async () => {
    getEnvMock.mockResolvedValueOnce({ env: [] });

    renderDialog();

    // The t function substitutes {name} with "my-skill"
    expect(screen.getByText("skills.env.title")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderDialog({ open: false });

    expect(screen.queryByText(/skills\.env\.title/)).not.toBeInTheDocument();
  });

  it("fetches env vars on open and renders input fields", async () => {
    getEnvMock.mockResolvedValueOnce({ env: envData });

    renderDialog();

    await waitFor(() => {
      expect(getEnvMock).toHaveBeenCalledWith("test-instance", "my-skill");
    });

    // Env var labels
    await waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
      expect(screen.getByText("BASE_URL")).toBeInTheDocument();
    });

    // Descriptions
    expect(screen.getByText("The API key for the service")).toBeInTheDocument();
    expect(screen.getByText("Base URL of the service")).toBeInTheDocument();
  });

  it("renders pre-filled values for configured env vars", async () => {
    getEnvMock.mockResolvedValueOnce({ env: envData });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("BASE_URL")).toBeInTheDocument();
    });

    const baseUrlInput = screen.getByLabelText("BASE_URL") as HTMLInputElement;
    expect(baseUrlInput.value).toBe("https://example.com");
  });

  it("renders sensitive fields as password type by default", async () => {
    getEnvMock.mockResolvedValueOnce({ env: envData });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });

    const apiKeyInput = screen.getByLabelText("API_KEY");
    expect(apiKeyInput).toHaveAttribute("type", "password");
  });

  it("renders non-sensitive fields as text type", async () => {
    getEnvMock.mockResolvedValueOnce({ env: envData });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("BASE_URL")).toBeInTheDocument();
    });

    const baseUrlInput = screen.getByLabelText("BASE_URL");
    expect(baseUrlInput).toHaveAttribute("type", "text");
  });

  it("toggles password visibility for sensitive fields", async () => {
    const user = userEvent.setup();
    getEnvMock.mockResolvedValueOnce({
      env: [envData[0]], // only API_KEY (sensitive)
    });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });

    const apiKeyInput = screen.getByLabelText("API_KEY");
    expect(apiKeyInput).toHaveAttribute("type", "password");

    // Click the eye toggle button (the ghost button next to the input)
    const toggleBtns = screen.getAllByRole("button").filter(
      (btn) => btn.getAttribute("type") === "button" && btn.classList.contains("absolute"),
    );
    if (toggleBtns.length > 0) {
      await user.click(toggleBtns[0]);
      expect(apiKeyInput).toHaveAttribute("type", "text");
    }
  });

  it("calls api.skills.setEnv on save with correct data", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    getEnvMock.mockResolvedValueOnce({ env: envData });
    setEnvMock.mockResolvedValueOnce({ env: envData });

    renderDialog({ onSaved, onOpenChange });

    await waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });

    // Fill in the API_KEY field
    const apiKeyInput = screen.getByLabelText("API_KEY");
    await user.type(apiKeyInput, "sk-123456");

    // Click save
    await user.click(screen.getByRole("button", { name: "common.saveSingle" }));

    await waitFor(() => {
      expect(setEnvMock).toHaveBeenCalledWith("test-instance", "my-skill", [
        { key: "API_KEY", value: "sk-123456", sensitive: true },
        { key: "BASE_URL", value: "https://example.com", sensitive: false },
      ]);
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("shows success toast after save", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    getEnvMock.mockResolvedValueOnce({ env: envData });
    setEnvMock.mockResolvedValueOnce({ env: envData });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "common.saveSingle" }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("skills.env.saved");
    });
  });

  it("shows error toast when save fails", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    getEnvMock.mockResolvedValueOnce({ env: envData });
    setEnvMock.mockRejectedValueOnce(new Error("save failed"));

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "common.saveSingle" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("general.saveFailed");
    });
  });

  it("shows 'no vars' message when env is empty", async () => {
    getEnvMock.mockResolvedValueOnce({ env: [] });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("skills.env.noVars")).toBeInTheDocument();
    });
  });

  it("shows error toast when loading fails", async () => {
    const { toast } = await import("sonner");
    getEnvMock.mockRejectedValueOnce(new Error("load failed"));

    renderDialog();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("skills.env.loadFailed");
    });
  });

  it("disables save button while loading", () => {
    // getEnv never resolves so loading stays true
    getEnvMock.mockReturnValueOnce(new Promise(() => {}));

    renderDialog();

    const saveBtn = screen.getByRole("button", { name: "common.saveSingle" });
    expect(saveBtn).toBeDisabled();
  });
});
