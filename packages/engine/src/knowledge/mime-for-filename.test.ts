// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { mimeForFilename } from "./mime-for-filename.js";

describe("mimeForFilename", () => {
  it("should_map_markdown_and_plain_text_extensions", () => {
    expect(mimeForFilename("a.md")).toBe("text/markdown");
    expect(mimeForFilename("a.markdown")).toBe("text/markdown");
    expect(mimeForFilename("a.txt")).toBe("text/plain");
  });

  it("should_map_html_and_htm_to_text_html_in_any_case", () => {
    expect(mimeForFilename("page.html")).toBe("text/html");
    expect(mimeForFilename("page.htm")).toBe("text/html");
    expect(mimeForFilename("PAGE.HTML")).toBe("text/html");
  });

  it("should_fall_back_to_text_plain_for_an_unknown_or_missing_extension", () => {
    expect(mimeForFilename("a.xlsx")).toBe("text/plain");
    expect(mimeForFilename("README")).toBe("text/plain");
  });
});
