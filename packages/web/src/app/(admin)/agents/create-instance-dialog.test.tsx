// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateInstanceDialog } from "./create-instance-dialog";

// ── Mocks ───────────────────────────────────────────────────────────

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: pushMock, refresh: refreshMock })),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

const createMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    instances: {
      create: (...args: unknown[]) => createMock(...args),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Helpers ─────────────────────────────────────────────────────────

function renderDialog(props: Partial<React.ComponentProps<typeof CreateInstanceDialog>> = {}) {
  const defaults = {
    open: true,
    onOpenChange: vi.fn(),
    onCreated: vi.fn(),
  };
  return render(<CreateInstanceDialog {...defaults} {...props} />);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("CreateInstanceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the step 1 form fields when open", () => {
    renderDialog();

    expect(screen.getByText("instances.create.title")).toBeInTheDocument();
    expect(screen.getByText("instances.create.description")).toBeInTheDocument();
    expect(screen.getByLabelText("instances.table.name")).toBeInTheDocument();
    expect(screen.getByLabelText("instances.table.slug")).toBeInTheDocument();
    expect(screen.getByLabelText("instances.table.description")).toBeInTheDocument();
  });

  it("does not render dialog content when closed", () => {
    renderDialog({ open: false });

    expect(screen.queryByText("instances.create.title")).not.toBeInTheDocument();
  });

  it("auto-generates slug from the name", async () => {
    const user = userEvent.setup();
    renderDialog();

    const nameInput = screen.getByLabelText("instances.table.name");
    await user.type(nameInput, "My Test Bot");

    const slugInput = screen.getByLabelText("instances.table.slug") as HTMLInputElement;
    expect(slugInput.value).toBe("my-test-bot");
  });

  it("stops auto-generating slug once user manually edits it", async () => {
    const user = userEvent.setup();
    renderDialog();

    const nameInput = screen.getByLabelText("instances.table.name");
    const slugInput = screen.getByLabelText("instances.table.slug");

    await user.type(nameInput, "Bot");
    expect(slugInput).toHaveValue("bot");

    // Manually edit the slug — toSlug is applied per keystroke, so trailing
    // hyphens are stripped incrementally. "myslug" avoids that edge case.
    await user.clear(slugInput);
    await user.type(slugInput, "myslug");
    expect(slugInput).toHaveValue("myslug");

    // Now typing in name should NOT change slug because slugEdited is true
    await user.clear(nameInput);
    await user.type(nameInput, "Changed Name");
    expect(slugInput).toHaveValue("myslug");
  });

  it("slugifies special characters correctly", async () => {
    const user = userEvent.setup();
    renderDialog();

    const nameInput = screen.getByLabelText("instances.table.name");
    await user.type(nameInput, "Hello World!!! @#$ Test");

    const slugInput = screen.getByLabelText("instances.table.slug") as HTMLInputElement;
    expect(slugInput.value).toBe("hello-world-test");
  });

  it("disables continue button when name is empty", () => {
    renderDialog();

    const continueBtn = screen.getByRole("button", { name: "common.continue" });
    expect(continueBtn).toBeDisabled();
  });

  it("enables continue button when name and slug are filled", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("instances.table.name"), "My Bot");

    const continueBtn = screen.getByRole("button", { name: "common.continue" });
    expect(continueBtn).toBeEnabled();
  });

  it("advances to step 2 (review) on continue click", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("instances.table.name"), "My Bot");
    await user.click(screen.getByRole("button", { name: "common.continue" }));

    expect(screen.getByText("instances.create.reviewTitle")).toBeInTheDocument();
    expect(screen.getByText("My Bot")).toBeInTheDocument();
    expect(screen.getByText("my-bot")).toBeInTheDocument();
  });

  it("can go back from step 2 to step 1", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("instances.table.name"), "My Bot");
    await user.click(screen.getByRole("button", { name: "common.continue" }));

    expect(screen.getByText("instances.create.reviewTitle")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "common.back" }));

    expect(screen.getByText("instances.create.title")).toBeInTheDocument();
    expect(screen.getByLabelText("instances.table.name")).toHaveValue("My Bot");
  });

  it("calls api.instances.create on confirm and navigates to instance page", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    createMock.mockResolvedValueOnce({ agent: { slug: "my-bot" } });

    renderDialog({ onCreated });

    await user.type(screen.getByLabelText("instances.table.name"), "My Bot");
    await user.type(screen.getByLabelText("instances.table.description"), "A description");
    await user.click(screen.getByRole("button", { name: "common.continue" }));

    await user.click(screen.getByRole("button", { name: "instances.create.button" }));

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith({
        name: "My Bot",
        slug: "my-bot",
        description: "A description",
      });
    });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
      expect(pushMock).toHaveBeenCalledWith("/agents/my-bot");
    });
  });

  it("omits description from API call when empty", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValueOnce({ agent: { slug: "bot" } });

    renderDialog();

    await user.type(screen.getByLabelText("instances.table.name"), "Bot");
    await user.click(screen.getByRole("button", { name: "common.continue" }));
    await user.click(screen.getByRole("button", { name: "instances.create.button" }));

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith({
        name: "Bot",
        slug: "bot",
        description: undefined,
      });
    });
  });

  it("shows error toast when creation fails", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    createMock.mockRejectedValueOnce(new Error("Conflict"));

    renderDialog();

    await user.type(screen.getByLabelText("instances.table.name"), "Bot");
    await user.click(screen.getByRole("button", { name: "common.continue" }));
    await user.click(screen.getByRole("button", { name: "instances.create.button" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("instances.create.error");
    });
  });
});
