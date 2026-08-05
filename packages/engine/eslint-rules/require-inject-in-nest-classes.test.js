// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import rule from "./require-inject-in-nest-classes.js";

// `typescript-eslint` is a direct dependency (used in eslint.config.js) and
// re-exports the parser as `.parser` — more robust than importing the scoped
// `@typescript-eslint/parser` package directly.
function lint(code) {
  const linter = new Linter();
  return linter.verify(code, {
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: "module" },
    plugins: { local: { rules: { "require-inject": rule } } },
    rules: { "local/require-inject": "error" },
  });
}

describe("require-inject-in-nest-classes", () => {
  it("flags a NestJS class constructor param without @Inject", () => {
    const msgs = lint(`@Injectable() class S { constructor(private readonly a: A) {} }`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messageId).toBe("missingInject");
  });

  it("flags @Controller the same way", () => {
    const msgs = lint(`@Controller("v1") class C { constructor(private readonly s: Svc) {} }`);
    expect(msgs).toHaveLength(1);
  });

  it("accepts a param decorated with @Inject", () => {
    const msgs = lint(`@Injectable() class S { constructor(@Inject(A) private readonly a: A) {} }`);
    expect(msgs).toHaveLength(0);
  });

  it("accepts a plain (non-decorated) class with constructor params", () => {
    const msgs = lint(`class Plain { constructor(private readonly x: string) {} }`);
    expect(msgs).toHaveLength(0);
  });

  it("accepts a NestJS class with no constructor", () => {
    const msgs = lint(`@Injectable() class S {}`);
    expect(msgs).toHaveLength(0);
  });

  it("reports one error per missing param", () => {
    const msgs = lint(`@Injectable() class S { constructor(a: A, @Inject(B) b: B, c: C) {} }`);
    expect(msgs).toHaveLength(2);
  });
});
