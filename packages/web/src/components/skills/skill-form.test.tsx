// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillForm } from "./skill-form";

// ── Mocks ───────────────────────────────────────────────────────────

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: pushMock, refresh: vi.fn() })),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

const createMock = vi.fn();
const updateMock = vi.fn();

vi.mock("@/lib/api", () => ({
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
  api: {
    skillLibrary: {
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Tests ───────────────────────────────────────────────────────────

describe("SkillForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    vi.restoreAllMocks();
  });

  describe("create mode", () => {
    it("renders all form fields", () => {
      render(<SkillForm mode="create" />);

      expect(screen.getByText("skills.form.newTitle")).toBeInTheDocument();
      expect(screen.getByLabelText("skills.form.name")).toBeInTheDocument();
      expect(screen.getByLabelText("skills.form.description")).toBeInTheDocument();
      expect(screen.getByLabelText("skills.form.content")).toBeInTheDocument();
      expect(screen.getByText("skills.form.requiredEnv")).toBeInTheDocument();
    });

    it("disables save button when name and content are empty", () => {
      render(<SkillForm mode="create" />);

      const saveBtn = screen.getByRole("button", { name: "common.saveSingle" });
      expect(saveBtn).toBeDisabled();
    });

    it("enables save button when name and content are filled", async () => {
      const user = userEvent.setup();
      render(<SkillForm mode="create" />);

      await user.type(screen.getByLabelText("skills.form.name"), "my-skill");
      await user.type(screen.getByLabelText("skills.form.content"), "Some content");

      const saveBtn = screen.getByRole("button", { name: "common.saveSingle" });
      expect(saveBtn).toBeEnabled();
    });

    it("normalizes name input to lowercase with hyphens only", async () => {
      const user = userEvent.setup();
      render(<SkillForm mode="create" />);

      const nameInput = screen.getByLabelText("skills.form.name");
      await user.type(nameInput, "My Skill Name!");

      // The component replaces non [a-z0-9-] with hyphens and lowercases
      expect(nameInput).toHaveValue("my-skill-name-");
    });

    it("calls api.skillLibrary.create on save in create mode", async () => {
      const user = userEvent.setup();
      createMock.mockResolvedValueOnce({ name: "my-skill" });

      render(<SkillForm mode="create" />);

      await user.type(screen.getByLabelText("skills.form.name"), "my-skill");
      await user.type(screen.getByLabelText("skills.form.content"), "# Skill content");

      await user.click(screen.getByRole("button", { name: "common.saveSingle" }));

      await waitFor(() => {
        expect(createMock).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "my-skill",
            content: "# Skill content",
          }),
        );
      });

      await waitFor(() => {
        expect(pushMock).toHaveBeenCalledWith("/skills");
      });
    });

    it("shows error toast when save fails", async () => {
      const user = userEvent.setup();
      const { toast } = await import("sonner");
      createMock.mockRejectedValueOnce(new Error("Conflict"));

      render(<SkillForm mode="create" />);

      await user.type(screen.getByLabelText("skills.form.name"), "my-skill");
      await user.type(screen.getByLabelText("skills.form.content"), "content");

      await user.click(screen.getByRole("button", { name: "common.saveSingle" }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
    });
  });

  describe("edit mode", () => {
    const initialData = {
      name: "existing-skill",
      description: "A description",
      requiredEnv: [
        { name: "API_KEY", description: "The key", sensitive: true },
      ],
      content: "# Existing content",
    };

    it("renders with initial data", () => {
      render(<SkillForm mode="edit" initialData={initialData} />);

      expect(screen.getByText("existing-skill")).toBeInTheDocument();
      expect(screen.getByLabelText("skills.form.name")).toHaveValue("existing-skill");
      expect(screen.getByLabelText("skills.form.description")).toHaveValue("A description");
      expect(screen.getByLabelText("skills.form.content")).toHaveValue("# Existing content");
    });

    it("makes name input readonly in edit mode", () => {
      render(<SkillForm mode="edit" initialData={initialData} />);

      const nameInput = screen.getByLabelText("skills.form.name");
      expect(nameInput).toHaveAttribute("readonly");
    });

    it("save button is enabled in edit mode even when name is empty (validates differently)", () => {
      render(
        <SkillForm
          mode="edit"
          initialData={{ ...initialData, name: "" }}
        />,
      );

      const saveBtn = screen.getByRole("button", { name: "common.saveSingle" });
      // In edit mode isValid = true always (mode === "edit")
      expect(saveBtn).toBeEnabled();
    });

    it("renders existing env vars from initialData", () => {
      render(<SkillForm mode="edit" initialData={initialData} />);

      // The env var name "API_KEY" is rendered as an input value
      const envInputs = screen.getAllByPlaceholderText("skills.form.envNamePlaceholder");
      expect(envInputs[0]).toHaveValue("API_KEY");
    });

    it("calls api.skillLibrary.update on save in edit mode", async () => {
      const user = userEvent.setup();
      updateMock.mockResolvedValueOnce({ name: "existing-skill" });

      render(<SkillForm mode="edit" initialData={initialData} />);

      await user.click(screen.getByRole("button", { name: "common.saveSingle" }));

      await waitFor(() => {
        expect(updateMock).toHaveBeenCalledWith(
          "existing-skill",
          expect.objectContaining({
            description: "A description",
            content: "# Existing content",
          }),
        );
      });
    });
  });

  describe("env var management", () => {
    it("adds a new env var row when clicking add button", async () => {
      const user = userEvent.setup();
      render(<SkillForm mode="create" />);

      const addBtn = screen.getByRole("button", { name: /skills\.form\.addVariable/ });
      await user.click(addBtn);

      expect(
        screen.getByPlaceholderText("skills.form.envNamePlaceholder"),
      ).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("skills.form.envDescPlaceholder"),
      ).toBeInTheDocument();
    });

    it("removes an env var row when clicking the delete button", async () => {
      const user = userEvent.setup();
      render(
        <SkillForm
          mode="edit"
          initialData={{
            name: "test",
            description: "",
            requiredEnv: [
              { name: "VAR_A", sensitive: true },
              { name: "VAR_B", sensitive: false },
            ],
            content: "content",
          }}
        />,
      );

      const envNameInputs = screen.getAllByPlaceholderText("skills.form.envNamePlaceholder");
      expect(envNameInputs).toHaveLength(2);

      // Click the first delete button (trash icon buttons)
      const deleteButtons = screen.getAllByRole("button").filter(
        (btn) => btn.querySelector("svg.lucide-trash-2") !== null ||
                 btn.closest("[class*='shrink-0']") !== null,
      );
      // More reliable: find buttons next to env var rows; we look for buttons with Trash2 icon
      // The Trash2 buttons are size="icon" variant="ghost" — they lack text
      const iconButtons = screen.getAllByRole("button").filter(
        (btn) => btn.textContent === "" && !btn.textContent?.includes("skills.form"),
      );
      // Click the first one that's an icon button for deletion
      if (iconButtons.length > 0) {
        await user.click(iconButtons[0]);
      }

      await waitFor(() => {
        const remaining = screen.getAllByPlaceholderText("skills.form.envNamePlaceholder");
        expect(remaining).toHaveLength(1);
      });
    });

    it("uppercases and replaces invalid chars in env var names", async () => {
      const user = userEvent.setup();
      render(<SkillForm mode="create" />);

      await user.click(screen.getByRole("button", { name: /skills\.form\.addVariable/ }));

      const envNameInput = screen.getByPlaceholderText("skills.form.envNamePlaceholder");
      await user.type(envNameInput, "my-api.key");

      // The handler converts to uppercase and replaces non [A-Z0-9_] with _
      expect(envNameInput).toHaveValue("MY_API_KEY");
    });
  });
});
