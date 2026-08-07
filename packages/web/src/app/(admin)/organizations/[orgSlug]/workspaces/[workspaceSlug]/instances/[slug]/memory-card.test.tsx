// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The memory switch and its embedder warning, now that both live in Parametri.
 *
 * These tests have followed the switch through three homes (model settings →
 * Generale → Conoscenza → Parametri). They are here rather than in the page's
 * test because the card owns its own dirty state and its own save: what has to
 * hold is that a flick does not persist, that Save writes only `memoryEnabled`,
 * and that the warning keys off the EMBEDDER, not the chat provider (#150).
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryCard } from "./memory-card";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
import type { Instance } from "@/lib/api";

const { mockUpdate, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/lib/api", () => ({
  api: { instances: { update: (...args: unknown[]) => mockUpdate(...args) } },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

function SaveButton() {
  const { saveAction } = usePageActions();
  if (!saveAction?.isDirty) return null;
  return <button onClick={() => saveAction.onSave()}>common.save</button>;
}

function renderWithProvider(ui: ReactElement) {
  return render(
    <PageActionsProvider>
      {ui}
      <SaveButton />
    </PageActionsProvider>,
  );
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "a1",
    name: "A1",
    status: "active",
    provider: "openai",
    model: "gpt-4o",
    memoryEnabled: false,
    embeddingProvider: "openai",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as unknown as Instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation(async (_slug: string, patch: Record<string, unknown>) => ({
    instance: makeInstance(patch as Partial<Instance>),
  }));
});

describe("MemoryCard — the switch", () => {
  it("writes nothing on mount", () => {
    renderWithProvider(<MemoryCard instance={makeInstance()} onUpdate={vi.fn()} />);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.queryByText("common.save")).not.toBeInTheDocument();
  });

  it("does not persist on the flick", async () => {
    renderWithProvider(<MemoryCard instance={makeInstance()} onUpdate={vi.fn()} />);

    await userEvent.click(screen.getByLabelText("settings.tab.memory"));

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.getByText("common.save")).toBeInTheDocument();
  });

  it("persists only its own flag on save", async () => {
    const onUpdate = vi.fn();
    renderWithProvider(<MemoryCard instance={makeInstance()} onUpdate={onUpdate} />);

    await userEvent.click(screen.getByLabelText("settings.tab.memory"));
    await userEvent.click(screen.getByText("common.save"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("a1", { memoryEnabled: true });
    });
    expect(onUpdate).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it("surfaces a failure instead of pretending it saved", async () => {
    mockUpdate.mockRejectedValue(new Error("nope"));
    renderWithProvider(<MemoryCard instance={makeInstance()} onUpdate={vi.fn()} />);

    await userEvent.click(screen.getByLabelText("settings.tab.memory"));
    await userEvent.click(screen.getByText("common.save"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

describe("MemoryCard — the embedder warning", () => {
  it("warns about a missing OpenAI key for an openai embedder", () => {
    renderWithProvider(
      <MemoryCard
        instance={makeInstance({
          memoryEnabled: true,
          embeddingProvider: "openai",
          memory: { needsOpenAIKey: true, canEnable: false },
        })}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("memory.banner.openaiNeedsKey")).toBeInTheDocument();
  });

  // The #150 case: the CHAT provider is anthropic, the embedder is bedrock, and
  // the warning must follow the embedder.
  it("warns about AWS for a bedrock embedder, whatever the chat provider is", () => {
    renderWithProvider(
      <MemoryCard
        instance={makeInstance({
          provider: "anthropic",
          memoryEnabled: true,
          embeddingProvider: "bedrock",
          memory: { needsOpenAIKey: true, canEnable: false },
        })}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("memory.banner.bedrockNeedsAws")).toBeInTheDocument();
    expect(screen.queryByText("memory.banner.openaiNeedsKey")).not.toBeInTheDocument();
  });

  it("stays quiet when the engine reports nothing missing", () => {
    renderWithProvider(
      <MemoryCard
        instance={makeInstance({
          memoryEnabled: true,
          memory: { needsOpenAIKey: false, canEnable: true },
        })}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.queryByText("memory.banner.openaiNeedsKey")).not.toBeInTheDocument();
    expect(screen.queryByText("memory.banner.bedrockNeedsAws")).not.toBeInTheDocument();
  });

  // Off means off: no warning about credentials for something not running.
  it("stays quiet when memory is off", () => {
    renderWithProvider(
      <MemoryCard
        instance={makeInstance({
          memoryEnabled: false,
          memory: { needsOpenAIKey: true, canEnable: false },
        })}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.queryByText("memory.banner.openaiNeedsKey")).not.toBeInTheDocument();
  });
});
