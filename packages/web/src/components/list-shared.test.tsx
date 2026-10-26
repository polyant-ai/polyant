// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { screen, within } from "@testing-library/react";
import { renderWithProviders, userEvent } from "@/test-utils";
import { ListSearch, ListToolbar, matchesSearch } from "./list-search";
import { ListEmpty, ListNoResults } from "./list-states";
import { Badge } from "@/components/ui/badge";
import { ListDrawer } from "./list-drawer";
import { ListBadgeCell, ListMetaCell, ListNameCell } from "./list-table";

describe("matchesSearch", () => {
  it("finds a row by any word of its visible text, in any order, ignoring case", () => {
    expect(matchesSearch("ADA mail", "Ada Lovelace", "ada@example.com", "Gmail")).toBe(true);
    expect(matchesSearch("lovelace ada", "Ada Lovelace")).toBe(true);
  });

  it("rejects a row when one of the words is missing from all its text", () => {
    expect(matchesSearch("ada zed", "Ada Lovelace", "ada@example.com")).toBe(false);
  });

  it("keeps every row for an empty or blank query", () => {
    expect(matchesSearch("", "anything")).toBe(true);
    expect(matchesSearch("   ", null, undefined)).toBe(true);
  });
});

describe("ListSearch", () => {
  it("reports what is typed and is reachable by its accessible name", async () => {
    const seen: string[] = [];
    function Harness() {
      const [value, setValue] = useState("");
      return <ListSearch value={value} onChange={(v) => { seen.push(v); setValue(v); }} />;
    }
    renderWithProviders(<Harness />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Cerca" }), "ab");
    expect(seen).toEqual(["a", "ab"]);
  });
});

describe("list states", () => {
  it("shows the empty title, description and action together", () => {
    renderWithProviders(<ListEmpty title="Nessuna skill" description="Aggiungine una" action={<button>Aggiungi</button>} />);
    expect(screen.getByText("Nessuna skill")).toBeInTheDocument();
    expect(screen.getByText("Aggiungine una")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aggiungi" })).toBeInTheDocument();
  });

  it("says there are no results when a search matches nothing", () => {
    renderWithProviders(<ListNoResults />);
    expect(screen.getByText("Nessun risultato")).toBeInTheDocument();
  });
});

describe("ListDrawer", () => {
  const buttons = () =>
    within(document.querySelector("[data-slot=sheet-footer]") as HTMLElement)
      .getAllByRole("button")
      .map((b) => b.textContent);

  // A drawer that only shows ends in one Close; one that edits ends in Cancel and
  // its primary button. Both keep the destructive action on the left.
  it("ends a drawer that only shows in a single Close", () => {
    renderWithProviders(<ListDrawer open onOpenChange={() => {}} title="Titolo" description="Riga">corpo</ListDrawer>);
    expect(screen.getByText("Riga")).toBeInTheDocument();
    expect(buttons()).toEqual(["Chiudi"]);
  });

  it("orders the footer: destructive on the left, then the extras, Cancel and the primary button", () => {
    renderWithProviders(
      <ListDrawer
        open
        onOpenChange={() => {}}
        title="Titolo"
        description="Riga"
        destructive={<button>Elimina</button>}
        actions={<button>Esporta</button>}
        primary={<button>Salva</button>}
      >
        corpo
      </ListDrawer>,
    );
    expect(buttons()).toEqual(["Elimina", "Esporta", "Annulla", "Salva"]);
  });

  it("closes from Cancel", async () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ListDrawer open onOpenChange={onOpenChange} title="T" description="D" primary={<button>Salva</button>}>
        corpo
      </ListDrawer>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Annulla" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ListNameCell", () => {
  it("keeps the full summary in the title so a clamped line can still be read", () => {
    renderWithProviders(
      <table><tbody><tr><ListNameCell name="Ada" summary="una descrizione molto lunga" /></tr></tbody></table>,
    );
    expect(screen.getByTitle("una descrizione molto lunga")).toHaveClass("line-clamp-2");
  });
});

describe("ListBadgeCell and ListMetaCell", () => {
  it("draw a status as the default badge and a date as muted text, aligned to the end when asked", () => {
    renderWithProviders(
      <table>
        <tbody>
          <tr>
            <ListBadgeCell>ready</ListBadgeCell>
            <td><Badge variant="secondary">reference</Badge></td>
            <ListMetaCell align="end">2 hours ago</ListMetaCell>
          </tr>
        </tbody>
      </table>,
    );
    const badge = screen.getByText("ready");
    // The same classes as a bare default Badge: no size override.
    expect(badge.className).toBe(screen.getByText("reference").className);
    const meta = screen.getByText("2 hours ago");
    expect(meta).toHaveClass("text-muted-foreground", "text-right");
  });
});

describe("ListToolbar", () => {
  it("puts the search box first and the filters to its right", () => {
    renderWithProviders(
      <ListToolbar value="" onChange={() => {}}>
        <button type="button">Filter</button>
      </ListToolbar>,
    );
    const items = [screen.getByRole("searchbox"), screen.getByRole("button", { name: "Filter" })];
    expect(items[0].compareDocumentPosition(items[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
