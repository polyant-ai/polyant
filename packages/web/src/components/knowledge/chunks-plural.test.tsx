// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils";
import { useI18n } from "@/lib/i18n/context";

function Chunks({ count }: { count: number }) {
  const { t } = useI18n();
  return <span>{t("knowledge.tab.chunks", { count })}</span>;
}

describe("a document's chunk count", () => {
  // The line under a filename said "1 chunks".
  it("reads 1 chunk for one and N chunks for more", () => {
    const { rerender } = renderWithProviders(<Chunks count={1} />);
    expect(screen.getByText("1 chunk")).toBeInTheDocument();
    rerender(<Chunks count={3} />);
    expect(screen.getByText("3 chunk")).toBeInTheDocument();
  });
});
