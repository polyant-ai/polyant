// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bundleDocumentSchema, prepareImportDocuments } from "./import-bundle.js";

const doc = (filename: string, content: string) => ({ filename, content });

describe("prepareImportDocuments", () => {
  it("should_trim_the_content_strip_the_path_and_derive_size_and_mime", () => {
    const [d] = prepareImportDocuments({ documents: [doc(" dir/page.html ", "  <p>hi</p>  ")] });
    expect(d).toMatchObject({
      requestedName: "page.html",
      content: "<p>hi</p>",
      sizeBytes: 9,
      mimeType: "text/html",
    });
  });

  it("should_reject_a_malformed_bundle_with_the_first_issue", () => {
    expect(() => prepareImportDocuments({ documents: [] })).toThrow(/^Invalid import bundle: /);
    expect(() => prepareImportDocuments(null)).toThrow(BadRequestException);
  });

  it("should_reject_an_empty_filename_or_content_naming_the_document", () => {
    expect(() => prepareImportDocuments({ documents: [doc("   ", "x")] })).toThrow(
      "Document 1: filename must not be empty or a path component",
    );
    expect(() => prepareImportDocuments({ documents: [doc("a.txt", "   ")] })).toThrow(
      'Document "a.txt": content must not be empty',
    );
  });

  it("should_reject_a_document_over_five_megabytes", () => {
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    expect(() => prepareImportDocuments({ documents: [doc("big.txt", big)] })).toThrow(/exceeds the 5 MB limit/);
  });

  it("should_hand_back_the_extra_fields_of_a_caller_supplied_document_schema", () => {
    const withSource = bundleDocumentSchema.extend({ source: z.enum(["agent", "plugin"]).optional() });
    const [d] = prepareImportDocuments(
      { documents: [{ ...doc("a.txt", "hi"), source: "plugin" }] },
      { documentSchema: withSource },
    );
    expect(d.document.source).toBe("plugin");
  });

  it("should_map_the_stored_type_with_a_caller_supplied_function", () => {
    const [d] = prepareImportDocuments({ documents: [doc("a.txt", "hi")] }, { mimeFor: () => "application/x-test" });
    expect(d.mimeType).toBe("application/x-test");
  });
});
