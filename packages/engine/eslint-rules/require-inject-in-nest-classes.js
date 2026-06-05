// SPDX-License-Identifier: AGPL-3.0-or-later

const DEFAULT_CLASS_DECORATORS = ["Injectable", "Controller", "Catch"];
const DEFAULT_INJECT_DECORATORS = ["Inject"];

/** @returns {string|undefined} the decorator's callee/identifier name */
function decoratorName(dec) {
  const expr = dec.expression;
  if (!expr) return undefined;
  if (expr.type === "CallExpression" && expr.callee.type === "Identifier") return expr.callee.name;
  if (expr.type === "Identifier") return expr.name;
  return undefined;
}

function paramName(param) {
  if (param.type === "TSParameterProperty") return paramName(param.parameter);
  if (param.type === "Identifier") return param.name;
  if (param.type === "AssignmentPattern" && param.left.type === "Identifier") return param.left.name;
  return "<param>";
}

function paramDecorators(param) {
  const own = param.decorators ?? [];
  const inner = param.type === "TSParameterProperty" ? (param.parameter?.decorators ?? []) : [];
  return [...own, ...inner];
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require explicit @Inject(...) on every constructor parameter of NestJS-managed classes. Under tsx (esbuild) emitDecoratorMetadata is unavailable, so type-based DI resolves to undefined.",
    },
    schema: [
      {
        type: "object",
        properties: {
          classDecorators: { type: "array", items: { type: "string" } },
          injectDecorators: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingInject:
        "Constructor parameter '{{name}}' in a NestJS-managed class must use explicit @Inject(...) — tsx does not emit decorator metadata; type-based injection resolves to undefined.",
    },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    const classDecos = new Set(opts.classDecorators ?? DEFAULT_CLASS_DECORATORS);
    const injectDecos = new Set(opts.injectDecorators ?? DEFAULT_INJECT_DECORATORS);

    function check(node) {
      const classDecorators = node.decorators ?? [];
      const isNestManaged = classDecorators.some((d) => classDecos.has(decoratorName(d)));
      if (!isNestManaged) return;

      const ctor = node.body.body.find(
        (m) => m.type === "MethodDefinition" && m.kind === "constructor",
      );
      if (!ctor || !ctor.value || !ctor.value.params) return;

      for (const param of ctor.value.params) {
        const hasInject = paramDecorators(param).some((d) => injectDecos.has(decoratorName(d)));
        if (!hasInject) {
          context.report({ node: param, messageId: "missingInject", data: { name: paramName(param) } });
        }
      }
    }

    return { ClassDeclaration: check, ClassExpression: check };
  },
};

export default rule;
