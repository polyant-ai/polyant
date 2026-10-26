// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders, userEvent } from "@/test-utils";
import { SwitchList } from "./switch-list";

interface Item {
  id: string;
  title: string;
  note?: string;
  on: boolean;
  kind: string;
}

const ITEMS: Item[] = [
  { id: "2", title: "Beta", note: "second item", on: false, kind: "x" },
  { id: "1", title: "alpha", note: "first item", on: true, kind: "y" },
  { id: "3", title: "Gamma", on: true, kind: "x" },
];

function renderList(over: Partial<React.ComponentProps<typeof SwitchList<Item>>> = {}) {
  const onToggle = vi.fn().mockResolvedValue(undefined);
  renderWithProviders(
    <SwitchList<Item>
      rows={ITEMS}
      rowKey={(i) => i.id}
      name={(i) => i.title}
      nameHeader="Nome"
      summary={(i) => i.note}
      columns={[{ header: "Tipo", className: "w-24", cell: (i) => i.kind }]}
      isOn={(i) => i.on}
      onToggle={onToggle}
      switchLabel={(i) => `Attivo: ${i.title}`}
      {...over}
    />,
  );
  return { onToggle };
}

describe("SwitchList", () => {
  it("lists rows by name, with the Active column last and the extra column before it", () => {
    renderList();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Nome", "Tipo", "Attivo"]);
    const names = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["alpha" + "first item", "Beta" + "second item", "Gamma"]);
  });

  it("filters on the name, the summary and the search text, and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderList({ searchText: (i) => [i.kind] });
    await user.type(screen.getByRole("searchbox"), "second");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "y");
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("Nessun risultato")).toBeInTheDocument();
  });

  it("shows the new position at once and sends it", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onToggle = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    renderList({ onToggle });
    const sw = screen.getByRole("switch", { name: "Attivo: Beta" });
    expect(sw).not.toBeChecked();
    await user.click(sw);
    expect(sw).toBeChecked();
    expect(onToggle).toHaveBeenCalledWith(ITEMS[0], true);
    release();
  });

  it("takes the position back when the write fails", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn().mockRejectedValue(new Error("refused"));
    renderList({ onToggle });
    const sw = screen.getByRole("switch", { name: "Attivo: Beta" });
    await user.click(sw);
    await waitFor(() => expect(sw).not.toBeChecked());
  });

  it("keeps a disabled row's switch off the table and says why", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderList({ disabledReason: (i) => (i.id === "3" ? "Always on" : null) });
    const sw = screen.getByRole("switch", { name: "Attivo: Gamma" });
    expect(sw).toBeDisabled();
    await user.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("opens the row's detail from the row or the name, never from the switch", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderList({ onOpen });
    await user.click(screen.getByRole("switch", { name: "Attivo: Beta" }));
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Beta" }));
    expect(onOpen).toHaveBeenCalledWith(ITEMS[0]);
  });
});

describe("SwitchList after a successful write", () => {
  it("keeps the chosen position until the rows are read again, then follows the rows", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn().mockResolvedValue(undefined);
    const props = {
      rowKey: (i: Item) => i.id,
      name: (i: Item) => i.title,
      nameHeader: "Nome",
      isOn: (i: Item) => i.on,
      onToggle,
      switchLabel: (i: Item) => `Attivo: ${i.title}`,
    };
    const { rerender } = renderWithProviders(<SwitchList<Item> rows={ITEMS} {...props} />);
    const sw = screen.getByRole("switch", { name: "Attivo: Beta" });
    await user.click(sw);
    await waitFor(() => expect(onToggle).toHaveBeenCalled());
    // The rows have not been read again: the old value must not flash back.
    expect(sw).toBeChecked();

    rerender(<SwitchList<Item> rows={ITEMS.map((i) => (i.id === "2" ? { ...i, on: true } : i))} {...props} />);
    expect(screen.getByRole("switch", { name: "Attivo: Beta" })).toBeChecked();

    // Someone switches it off elsewhere: the list shows that, not the old click.
    rerender(<SwitchList<Item> rows={ITEMS} {...props} />);
    expect(screen.getByRole("switch", { name: "Attivo: Beta" })).not.toBeChecked();
  });
});

describe("SwitchList layout", () => {
  it("keeps the search row and the table together in one element, so a parent's spacing cannot widen the gap", () => {
    const { container } = renderWithProviders(
      <div className="space-y-6">
        <SwitchList<Item>
          rows={ITEMS}
          rowKey={(i) => i.id}
          name={(i) => i.title}
          nameHeader="Nome"
          isOn={(i) => i.on}
          onToggle={async () => {}}
          switchLabel={(i) => i.title}
        />
      </div>,
    );
    const wrapper = container.querySelector("div.space-y-6")!.firstElementChild!;
    expect(wrapper.contains(screen.getByRole("searchbox"))).toBe(true);
    expect(wrapper.contains(screen.getByRole("table"))).toBe(true);
  });

  it("mutes the row of a switch that is off", () => {
    renderWithProviders(
      <SwitchList<Item>
        rows={ITEMS}
        rowKey={(i) => i.id}
        name={(i) => i.title}
        nameHeader="Nome"
        isOn={(i) => i.on}
        onToggle={async () => {}}
        switchLabel={(i) => i.title}
      />,
    );
    const off = screen.getByText("Beta").closest("tr")!;
    const on = screen.getByText("alpha").closest("tr")!;
    expect(off).toHaveClass("opacity-60");
    expect(on).not.toHaveClass("opacity-60");
  });

  it("keeps a date column on one line", () => {
    renderWithProviders(
      <SwitchList<Item>
        rows={ITEMS}
        rowKey={(i) => i.id}
        name={(i) => i.title}
        nameHeader="Nome"
        columns={[{ header: "Quando", nowrap: true, cell: () => "12 ott 2026, 10:00" }]}
        isOn={(i) => i.on}
        onToggle={async () => {}}
        switchLabel={(i) => i.title}
      />,
    );
    expect(screen.getAllByText("12 ott 2026, 10:00")[0].closest("td")).toHaveClass("whitespace-nowrap");
  });
});
