// SPDX-License-Identifier: AGPL-3.0-or-later

/** The part of a hast tree this plugin reads; the renderer's own types are not a dependency here. */
interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };
interface HastParent {
  children: HastNode[];
}

/** Code keeps its text whole: a span per token would break highlighting and copying. */
const VERBATIM = new Set(["pre", "code"]);

/**
 * Wraps every word of the rendered text in a `stream-word` span, for a reply
 * that is still streaming: the words fade in as they land. Position-keyed by
 * the renderer, a word already on screen keeps its node and does not fade
 * again; only the words appended since the last render do.
 */
export function rehypeStreamWords() {
  return (tree: HastParent) => {
    split(tree);
  };
}

function split(node: HastParent): void {
  const children: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && "value" in child) {
      for (const part of child.value.split(/(\s+)/)) {
        if (!part) continue;
        children.push(
          /^\s+$/.test(part)
            ? { type: "text", value: part }
            : { type: "element", tagName: "span", properties: { className: ["stream-word"] }, children: [{ type: "text", value: part }] },
        );
      }
      continue;
    }
    if (child.type === "element" && "tagName" in child && !VERBATIM.has(child.tagName)) split(child);
    children.push(child);
  }
  node.children = children;
}
