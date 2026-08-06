// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for the Knowledge tab's enable switch and its embedder warning.
 *
 * The switch MOVED here from the model settings, and the "your embedder has no
 * credentials" warning did not come with it — nor did the two tests that pinned
 * it. The consequence was silent: an admin turns retrieval on, gets a green
 * toast, uploads documents, and every one lands in `status: error` with nothing
 * on screen explaining why.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KnowledgeTab } from "./knowledge-tab";
import type { Instance } from "@/lib/api";

const { mockList, mockUpdate, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockList: vi.fn(),
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
  api: {
    knowledge: { list: (...args: unknown[]) => mockList(...args) },
    instances: { update: (...args: unknown[]) => mockUpdate(...args) },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "a1",
    name: "A1",
    status: "active",
    provider: "openai",
    model: "gpt-4o",
    knowledgeEnabled: true,
    embeddingProvider: "openai",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as unknown as Instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({ documents: [] });
  mockUpdate.mockImplementation(async (_slug: string, patch: Record<string, unknown>) => ({
    instance: makeInstance(patch as Partial<Instance>),
  }));
});

describe("KnowledgeTab — the embedder-credentials warning", () => {
  it("warns when retrieval is on and the embedder has no credentials", async () => {
    render(
      <KnowledgeTab
        slug="a1"
        instance={makeInstance({ embedder: { needsCredentials: true } })}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.knowledgeOpenaiWarning")).toBeInTheDocument();
    });
  });

  it("names AWS credentials for a bedrock embedder", async () => {
    render(
      <KnowledgeTab
        slug="a1"
        instance={makeInstance({
          embeddingProvider: "bedrock",
          embedder: { needsCredentials: true },
        })}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.knowledgeAwsWarning")).toBeInTheDocument();
    });
  });

  it("stays quiet when the embedder is configured", async () => {
    render(
      <KnowledgeTab
        slug="a1"
        instance={makeInstance({ embedder: { needsCredentials: false } })}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(screen.queryByText("settings.tab.knowledgeOpenaiWarning")).not.toBeInTheDocument();
  });

  it("stays quiet while retrieval is off, since nothing will be embedded", async () => {
    render(
      <KnowledgeTab
        slug="a1"
        instance={makeInstance({
          knowledgeEnabled: false,
          embedder: { needsCredentials: true },
        })}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(screen.queryByText("settings.tab.knowledgeOpenaiWarning")).not.toBeInTheDocument();
  });

  // The engine's answer, not a client-side recomputation: `memory` reports
  // all-false whenever memory is off, so it cannot speak for a knowledge-only
  // agent — which is exactly how this warning got lost.
  it("does not fall back to the memory status", async () => {
    render(
      <KnowledgeTab
        slug="a1"
        instance={makeInstance({
          memory: { needsOpenAIKey: false, canEnable: false },
          embedder: { needsCredentials: true },
        })}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.knowledgeOpenaiWarning")).toBeInTheDocument();
    });
  });
});

describe("KnowledgeTab — the enable switch", () => {
  it("writes only on change, never on mount", async () => {
    render(<KnowledgeTab slug="a1" instance={makeInstance()} onUpdate={vi.fn()} />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("persists the flag and reports success", async () => {
    const onUpdate = vi.fn();
    render(
      <KnowledgeTab
        slug="a1"
        instance={makeInstance({ knowledgeEnabled: false })}
        onUpdate={onUpdate}
      />,
    );
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("a1", { knowledgeEnabled: true });
    });
    expect(onUpdate).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it("surfaces a failure instead of pretending it saved", async () => {
    mockUpdate.mockRejectedValue(new Error("nope"));
    render(
      <KnowledgeTab
        slug="a1"
        instance={makeInstance({ knowledgeEnabled: false })}
        onUpdate={vi.fn()}
      />,
    );
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
