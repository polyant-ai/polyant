// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The extension rule the two packages disagree about, enforced instead of
 * remembered.
 *
 * `packages/engine` runs under Node with `"type": "module"`, so every relative
 * VALUE import must end in `.js` or the compiled output throws
 * ERR_MODULE_NOT_FOUND at runtime. Nothing caught a violation: the engine's
 * tsconfig uses `moduleResolution: "bundler"`, which accepts an extensionless
 * specifier, and so do tsx and vitest — so a bad import passed typecheck, lint,
 * every unit test and the build, and failed the first time anyone ran
 * `node dist/index.js`. Compliance was 1 928 out of 1 928 by habit, which is
 * exactly what a newcomer does not have.
 *
 * `packages/web` is the opposite: Next's bundler does not map `./x.js` onto
 * `x.ts`, so a `.js` specifier builds under tsc and vitest and fails
 * `next build`. The repo-wide rules file said ".js, no exceptions", which is how
 * two such imports got into web test files — where they survive only because
 * next build never compiles tests.
 *
 * TYPE-ONLY imports are exempt in both directions: they are erased before
 * anything resolves them. That is also how a wrong `.js` gets copied into a
 * value import unnoticed, so the rule reports the value ones and stays quiet
 * about the rest.
 */

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "Relative value imports must end in .js (Node ESM) or must be extensionless (Next bundler), per the `style` option.",
    },
    schema: [
      {
        type: "object",
        properties: { style: { enum: ["js", "extensionless"] } },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        'Relative import "{{value}}" must end in ".js" — Node ESM resolves no extension at runtime.',
      unexpected:
        'Relative import "{{value}}" must NOT end in ".js" — the Next bundler does not map it onto the .ts source.',
    },
  },

  create(context) {
    const style = context.options?.[0]?.style ?? "js";

    function check(node, source) {
      if (!source || typeof source.value !== "string") return;
      const value = source.value;
      if (!value.startsWith("./") && !value.startsWith("../")) return;
      // Type-only imports/exports are erased; they resolve nothing at runtime.
      if (node.importKind === "type" || node.exportKind === "type") return;

      const endsWithJs = value.endsWith(".js");
      // Leave other extensions alone: .json, .css, .svg have their own loaders.
      const hasOtherExtension = /\.[a-z0-9]+$/i.test(value) && !endsWithJs;
      if (hasOtherExtension) return;

      if (style === "js" && !endsWithJs) {
        context.report({
          node: source,
          messageId: "missing",
          data: { value },
          fix: (fixer) => fixer.replaceText(source, JSON.stringify(`${value}.js`)),
        });
      }
      if (style === "extensionless" && endsWithJs) {
        context.report({
          node: source,
          messageId: "unexpected",
          data: { value },
          fix: (fixer) => fixer.replaceText(source, JSON.stringify(value.slice(0, -3))),
        });
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
    };
  },
};

export default rule;
