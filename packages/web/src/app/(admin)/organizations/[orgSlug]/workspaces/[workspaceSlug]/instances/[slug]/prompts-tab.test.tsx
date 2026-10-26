// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptsTab } from "./prompts-tab";
import type { PromptSection } from "@/lib/api";

const { mockPromptsUpdate, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockPromptsUpdate: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

// The header's Save button lives outside this component; capture the action
// it registers so the test can drive it the way the header does.
const lastSaveAction = vi.hoisted(() => ({
  current: null as null | { isDirty: boolean; saving: boolean; onSave: () => void | Promise<void> },
}));
vi.mock("./page-actions-context", () => ({
  usePageSaveAction: (a: { isDirty: boolean; saving: boolean; onSave: () => void | Promise<void> }) => {
    lastSaveAction.current = a;
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { prompts: { update: (...args: unknown[]) => mockPromptsUpdate(...args) } },
  };
});

const PROMPTS: PromptSection[] = [
  { key: "01-identity", filename: "01-identity.md", title: "Identity", content: "You are a helpful assistant." },
  { key: "02-soul", filename: "02-soul.md", title: "Soul", content: "Be warm and concise." },
  { key: "04-safety", filename: "04-safety.md", title: "Safety", content: "Never share secrets." },
];

function renderTab(onUpdate = vi.fn()) {
  render(<PromptsTab slug="support-bot" prompts={PROMPTS} onUpdate={onUpdate} />);
  return { onUpdate };
}

beforeEach(() => {
  lastSaveAction.current = null;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("PromptsTab", () => {
  it("shows every section's prompt in its own editor, with an anchor to each", () => {
    renderTab();

    expect(screen.getByDisplayValue("You are a helpful assistant.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Be warm and concise.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Never share secrets.")).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "prompts.sidebarTitle" });
    // The seeded sections carry English titles in the database; the panel shows its own labels.
    expect(nav).toHaveTextContent("prompts.section.identity");
    expect(nav).toHaveTextContent("prompts.section.soul");
    expect(nav).toHaveTextContent("prompts.section.safety");
    expect(nav).not.toHaveTextContent("Identity");
    expect(screen.getByText("prompts.section.soul.description")).toBeInTheDocument();
    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("shows a section the author added under its own title, without a default description", () => {
    render(
      <PromptsTab
        slug="support-bot"
        prompts={[{ key: "08-refunds", filename: "08-refunds.md", title: "Rimborsi", content: "x" }]}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Rimborsi").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^prompts\.section\./)).not.toBeInTheDocument();
  });

  it("marks an edited section as modified, and clears it when the text is put back", async () => {
    const user = userEvent.setup();
    renderTab();

    const soul = screen.getByDisplayValue("Be warm and concise.");
    await user.type(soul, " Always.");

    expect(lastSaveAction.current?.isDirty).toBe(true);
    expect(screen.getByLabelText("prompts.modified")).toBeInTheDocument();

    await user.clear(soul);
    await user.type(soul, "Be warm and concise.");

    expect(lastSaveAction.current?.isDirty).toBe(false);
    expect(screen.queryByLabelText("prompts.modified")).not.toBeInTheDocument();
  });

  it("saves only the sections that changed, for this agent, and hands back the result", async () => {
    const user = userEvent.setup();
    const saved = PROMPTS.map((p) =>
      p.key === "02-soul" ? { ...p, content: "Be warm and concise. Always." } : p,
    );
    mockPromptsUpdate.mockResolvedValueOnce({ prompts: saved });
    const { onUpdate } = renderTab();

    await user.type(screen.getByDisplayValue("Be warm and concise."), " Always.");
    // Touched and then put back: no change, so it must not be written.
    const safety = screen.getByDisplayValue("Never share secrets.");
    await user.type(safety, "!");
    await user.type(safety, "{Backspace}");
    await lastSaveAction.current!.onSave();

    expect(mockPromptsUpdate).toHaveBeenCalledTimes(1);
    expect(mockPromptsUpdate).toHaveBeenCalledWith("support-bot", [
      { key: "02-soul", content: "Be warm and concise. Always." },
    ]);
    expect(onUpdate).toHaveBeenCalledWith(saved);
    expect(mockToastSuccess).toHaveBeenCalledWith("prompts.saved");
    await waitFor(() => expect(lastSaveAction.current?.isDirty).toBe(false));
  });

  it("keeps the edits and reports the failure when the save is refused", async () => {
    const user = userEvent.setup();
    mockPromptsUpdate.mockRejectedValueOnce(new Error("network"));
    const { onUpdate } = renderTab();

    await user.type(screen.getByDisplayValue("Never share secrets."), " Ever.");
    await lastSaveAction.current!.onSave();

    expect(mockToastError).toHaveBeenCalledWith("prompts.saveFailed");
    expect(onUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(lastSaveAction.current?.saving).toBe(false));
    expect(lastSaveAction.current?.isDirty).toBe(true);
    expect(screen.getByDisplayValue("Never share secrets. Ever.")).toBeInTheDocument();
  });
});
