// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/context";
import { releaseInfo } from "@/lib/release-info";
import AboutPage from "./page";

describe("AboutPage", () => {
  it("shows the public Polyant release information in Italian by default", () => {
    render(
      <I18nProvider>
        <AboutPage />
      </I18nProvider>,
    );

    expect(
      screen.getByRole("heading", { name: `Polyant ${releaseInfo.version}` }),
    ).toBeInTheDocument();
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
});
