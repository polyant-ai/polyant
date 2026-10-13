// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rendered through the real react-markdown, remark and rehype pipeline: the
 * reply comes from a model, so what this component lets through to the DOM is
 * the property worth pinning, and a mocked pipeline cannot show it.
 */

import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils";
import { MarkdownRenderer } from "./markdown-renderer";

describe("MarkdownRenderer", () => {
  it("renders markdown structure, including GFM tables", () => {
    renderWithProviders(
      <MarkdownRenderer
        content={"Some **bold** text\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |"}
      />,
    );

    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "2" })).toBeInTheDocument();
  });

  it("opens links in a new tab without handing the opener or referrer to the target", () => {
    renderWithProviders(<MarkdownRenderer content="[docs](https://example.com/docs)" />);

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("drops raw HTML from a reply instead of rendering or echoing it", () => {
    const { container } = renderWithProviders(
      <MarkdownRenderer
        content={'before <img src=x onerror="alert(1)"> <script>alert(2)</script> after'}
      />,
    );

    expect(container.querySelector("img, script, [onerror]")).toBeNull();
    expect(container).not.toHaveTextContent("<script>");
    expect(container).not.toHaveTextContent("onerror");
    expect(container).toHaveTextContent("before");
  });

  it("leaves a javascript: link without any target", () => {
    const { container } = renderWithProviders(
      <MarkdownRenderer content="[click](javascript:alert(1))" />,
    );

    expect(screen.getByText("click")).toBeInTheDocument();
    expect(container.querySelector("a[href]")).toBeNull();
  });

  // Highlighting is visible only as the classes highlight.js emits; the
  // sanitizer schema must keep allowing them on code and span.
  it("keeps syntax highlighting through the sanitizer", () => {
    const { container } = renderWithProviders(
      <MarkdownRenderer content={"```js\nconst answer = 42;\n```"} />,
    );

    expect(container.querySelector("code .hljs-keyword")).toHaveTextContent("const");
  });

  it("renders empty content without crashing", () => {
    const { container } = renderWithProviders(<MarkdownRenderer content="" />);
    expect(container).toHaveTextContent("");
  });
});
