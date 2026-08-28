// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import rule from "./relative-import-extension.js";

function lint(code, style) {
  const linter = new Linter();
  return linter.verify(code, {
    plugins: { polyant: { rules: { "relative-import-extension": rule } } },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    rules: { "polyant/relative-import-extension": ["error", { style }] },
  });
}

describe("relative-import-extension — style: js (engine)", () => {
  it("should_report_a_relative_value_import_with_no_extension", () => {
    const messages = lint(`import { a } from "./dep";`, "js");
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/must end in "\.js"/);
  });

  it("should_accept_the_same_import_with_js", () => {
    expect(lint(`import { a } from "./dep.js";`, "js")).toHaveLength(0);
  });

  /*
    Type-only imports are erased before anything resolves them, so they are
    correct either way — and that is exactly how a wrong `.js` gets copied from
    a type import into a value one unnoticed.
  */
  it("should_ignore_a_type_only_import", () => {
    expect(lint(`import type { A } from "./types";`, "js")).toHaveLength(0);
  });

  it("should_ignore_a_bare_package_specifier", () => {
    expect(lint(`import { z } from "zod";`, "js")).toHaveLength(0);
  });

  it("should_ignore_another_extension_that_has_its_own_loader", () => {
    expect(lint(`import data from "./fixture.json";`, "js")).toHaveLength(0);
  });

  it("should_also_cover_re_exports", () => {
    expect(lint(`export { a } from "./dep";`, "js")).toHaveLength(1);
    expect(lint(`export * from "./dep";`, "js")).toHaveLength(1);
  });
});

describe("relative-import-extension — style: extensionless (web)", () => {
  /*
    The inverse trap: Next's bundler does not map `./x.js` onto `x.ts`, so this
    builds under tsc and vitest and fails `next build`. The repo-wide rules file
    demanded `.js` "with no exceptions", which is how two of these reached web
    test files — where they survive only because next build never compiles them.
  */
  it("should_report_a_relative_value_import_ending_in_js", () => {
    const messages = lint(`import { a } from "./dep.js";`, "extensionless");
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/must NOT end in "\.js"/);
  });

  it("should_accept_the_extensionless_form", () => {
    expect(lint(`import { a } from "./dep";`, "extensionless")).toHaveLength(0);
  });
});
