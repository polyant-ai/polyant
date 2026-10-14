// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Text that is still arriving, one span per word, so each word fades in as it
 * lands. Spans are keyed by position: a word already on screen keeps its node
 * and does not fade again when the text grows.
 */
export function StreamingText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s+)/).map((part, i) =>
        !part || /^\s+$/.test(part) ? part : (
          <span key={i} className="stream-word">
            {part}
          </span>
        ),
      )}
    </>
  );
}
