// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { rehypeStreamWords } from "./rehype-stream-words";

const text = (value: string) => ({ type: "text", value });
const el = (tagName: string, children: unknown[]) => ({ type: "element", tagName, properties: {}, children });
const word = (value: string) => ({ type: "element", tagName: "span", properties: { className: ["stream-word"] }, children: [text(value)] });

describe("rehypeStreamWords", () => {
  it("wraps each word of the text in a fading span and keeps the spaces between them", () => {
    const tree = { type: "root", children: [el("p", [text("Ciao a "), el("strong", [text("tutti")])])] };
    rehypeStreamWords()(tree as never);
    expect(tree.children[0]).toEqual(el("p", [word("Ciao"), text(" "), word("a"), text(" "), el("strong", [word("tutti")])]));
  });

  it("leaves code whole", () => {
    const code = el("pre", [el("code", [text("npm run dev")])]);
    const tree = { type: "root", children: [code, el("p", [el("code", [text("x = 1")])])] };
    rehypeStreamWords()(tree as never);
    expect(tree.children).toEqual([el("pre", [el("code", [text("npm run dev")])]), el("p", [el("code", [text("x = 1")])])]);
  });
});
