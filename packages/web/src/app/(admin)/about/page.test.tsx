// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import { useSession } from "next-auth/react";
import { I18nProvider } from "@/lib/i18n/context";
import { releaseInfo } from "@/lib/release-info";
import AboutPage from "./page";

vi.mock("next-auth/react", () => ({
  useSession: vi.fn(),
}));

const mockUseSession = vi.mocked(useSession);

function mockSession(role: "platform_admin" | "user") {
  mockUseSession.mockReturnValue({
    data: { user: { id: "1", role, mustChangePassword: false }, expires: "" },
    status: "authenticated",
    update: vi.fn(),
  } as unknown as ReturnType<typeof useSession>);
}

describe("AboutPage", () => {
  beforeEach(() => {
    mockSession("user");
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ changelog: [] }),
    }) as unknown as typeof fetch;
  });

  it("shows the public Polyant release information in Italian by default", () => {
    render(
      <I18nProvider>
        <AboutPage />
      </I18nProvider>,
    );

    expect(screen.getByText("Polyant")).toBeInTheDocument();
    expect(screen.getByText(`v${releaseInfo.version}`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /agpl/i })).toHaveAttribute(
      "href",
      "https://www.gnu.org/licenses/agpl-3.0.html",
    );
    expect(screen.getByRole("link", { name: /github/i })).toHaveAttribute(
      "href",
      releaseInfo.repositoryUrl,
    );
    expect(screen.getByRole("link", { name: /plugin sdk/i })).toHaveAttribute(
      "href",
      releaseInfo.sdkUrl,
    );
    expect(screen.getByRole("link", { name: /exelab/i })).toHaveAttribute(
      "href",
      "https://www.exelab.com/",
    );
  });

  it("hides the changelog history from a non-platform-admin user", () => {
    render(
      <I18nProvider>
        <AboutPage />
      </I18nProvider>,
    );

    expect(screen.queryByText("Cronologia aggiornamenti")).not.toBeInTheDocument();
  });

  it("shows the changelog history for a platform admin", async () => {
    mockSession("platform_admin");
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          changelog: [{ version: "1.1.0", date: "2026-08-25", changes: [{ category: "Added", items: ["Thing"] }] }],
        }),
    }) as unknown as typeof fetch;

    render(
      <I18nProvider>
        <AboutPage />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("Cronologia aggiornamenti")).toBeInTheDocument());
    expect(screen.getByText("v1.1.0")).toBeInTheDocument();
  });
});
