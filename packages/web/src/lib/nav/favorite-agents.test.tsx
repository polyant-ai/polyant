// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The starred agents as the panel uses them: read once from the engine, a star
 * shown at once, and taken back with a message when the engine refuses it. The
 * engine boundary (`api.me`) and the toast are the only things replaced.
 *
 * The store lives for the page load, so every test starts by forgetting it.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  favoriteAgents: vi.fn(),
  addFavoriteAgent: vi.fn(),
  removeFavoriteAgent: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => h.toastError(...args) } }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      me: {
        ...actual.api.me,
        favoriteAgents: h.favoriteAgents,
        addFavoriteAgent: h.addFavoriteAgent,
        removeFavoriteAgent: h.removeFavoriteAgent,
      },
    },
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { FavoriteAgentButton } from "@/components/favorite-agent-button";
import { forgetFavoriteAgents, useFavoriteAgents } from "./favorite-agents";

function Star({ agentId }: { agentId: string }) {
  const favorites = useFavoriteAgents();
  return <FavoriteAgentButton active={favorites.isFavorite(agentId)} onToggle={() => favorites.toggle(agentId)} />;
}

function mountStar(agentId: string, wrapIn: (node: ReactNode) => ReactNode = (node) => node) {
  return render(<I18nProvider initialLocale="en">{wrapIn(<Star agentId={agentId} />)}</I18nProvider>);
}

const star = () => screen.getByRole("button", { name: /favorites/ });

/** A promise the test settles by hand, to look at the screen while the engine has not answered. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetFavoriteAgents();
});

describe("favorite agents", () => {
  it("shows the stars the engine holds for this person", async () => {
    h.favoriteAgents.mockResolvedValue({ agentIds: ["a1"] });
    mountStar("a1");
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(star()).toHaveAccessibleName("Remove from favorites");
  });

  it("lights the star at once and keeps it when the engine confirms", async () => {
    h.favoriteAgents.mockResolvedValue({ agentIds: [] });
    const answer = deferred<{ agentIds: string[] }>();
    h.addFavoriteAgent.mockReturnValue(answer.promise);
    mountStar("a1");
    await waitFor(() => expect(h.favoriteAgents).toHaveBeenCalled());

    await userEvent.click(star());
    expect(star()).toHaveAttribute("aria-pressed", "true");
    expect(h.addFavoriteAgent).toHaveBeenCalledWith("a1");

    await act(async () => answer.resolve({ agentIds: ["a1"] }));
    expect(star()).toHaveAttribute("aria-pressed", "true");
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("takes the star back and says so when the engine refuses", async () => {
    h.favoriteAgents.mockResolvedValue({ agentIds: [] });
    const answer = deferred<{ agentIds: string[] }>();
    h.addFavoriteAgent.mockReturnValue(answer.promise);
    mountStar("a1");
    await waitFor(() => expect(h.favoriteAgents).toHaveBeenCalled());

    await userEvent.click(star());
    expect(star()).toHaveAttribute("aria-pressed", "true");

    await act(async () => answer.reject(new Error("offline")));
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(h.toastError).toHaveBeenCalledWith("Could not update your favorites. Try again.");
  });

  it("puts a removed star back when the engine refuses the removal", async () => {
    h.favoriteAgents.mockResolvedValue({ agentIds: ["a1"] });
    h.removeFavoriteAgent.mockRejectedValue(new Error("offline"));
    mountStar("a1");
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(star());

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.removeFavoriteAgent).toHaveBeenCalledWith("a1");
    expect(star()).toHaveAttribute("aria-pressed", "true");
  });

  it("does not open the row or card it sits in", async () => {
    h.favoriteAgents.mockResolvedValue({ agentIds: [] });
    h.addFavoriteAgent.mockResolvedValue({ agentIds: ["a1"] });
    const opened = vi.fn();
    mountStar("a1", (node) => <a href="#agent" onClick={opened}>{node}</a>);
    await waitFor(() => expect(h.favoriteAgents).toHaveBeenCalled());

    await userEvent.click(star());

    expect(h.addFavoriteAgent).toHaveBeenCalledWith("a1");
    expect(opened).not.toHaveBeenCalled();
  });
});
