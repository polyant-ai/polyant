// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";

// Mock react-markdown to avoid complex ESM/remark issues in jsdom
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({ default: {} }));
vi.mock("rehype-highlight", () => ({ default: {} }));
vi.mock("rehype-sanitize", () => ({
  default: {},
  defaultSchema: { attributes: {} },
}));

// Must import AFTER mocks are declared (vitest hoists vi.mock)
import { MarkdownRenderer } from "./markdown-renderer";

describe("MarkdownRenderer", () => {
  it("renders plain text content", () => {
    render(<MarkdownRenderer content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("passes content as children to ReactMarkdown", () => {
    render(<MarkdownRenderer content="Some **markdown** text" />);
    // With our mock, the raw markdown string is rendered as-is
    expect(screen.getByTestId("markdown")).toHaveTextContent(
      "Some **markdown** text",
    );
  });

  it("renders with the default prose class", () => {
    const { container } = render(<MarkdownRenderer content="test" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("prose-sm");
    expect(wrapper?.className).toContain("max-w-none");
  });

  it("merges a custom className onto the wrapper", () => {
    const { container } = render(
      <MarkdownRenderer content="test" className="my-custom" />,
    );
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("my-custom");
    expect(wrapper?.className).toContain("prose-sm");
  });

  it("renders empty string content without crashing", () => {
    const { container } = render(<MarkdownRenderer content="" />);
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("renders multiline content", () => {
    render(<MarkdownRenderer content={"Line one\nLine two\nLine three"} />);
    const el = screen.getByTestId("markdown");
    expect(el).toHaveTextContent("Line one");
    expect(el).toHaveTextContent("Line two");
    expect(el).toHaveTextContent("Line three");
  });
});
