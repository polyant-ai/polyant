// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which messages a turn sends to the model, and when the oldest of them are
 * folded into the conversation summary.
 *
 * The summary covers the messages up to a point, saved with it; the history
 * starts right after that point. The two always meet, so no message is ever
 * in neither. Between two folds the history only grows at its end, so the
 * prefix the provider cached on one turn is the prefix of the next. A fold
 * happens once per block: when a turn's two new messages take the history past
 * {@link HISTORY_WINDOW_MAX}, everything but the last
 * {@link HISTORY_KEPT_AFTER_FOLD} is summarized once, and when the history
 * outgrows {@link HISTORY_CHAR_BUDGET}, enough of it to fit in half of that.
 */

/** The history a turn sends grows up to this many messages before a fold. */
export const HISTORY_WINDOW_MAX = 20;

/** How many of the most recent messages stay in the history after a fold. */
export const HISTORY_KEPT_AFTER_FOLD = 10;

/**
 * The most messages a turn reads. Above the window only when folds keep failing
 * (the summary model is down) or rows were written without a turn: the history
 * then stops growing here, and the fold that eventually succeeds reads the
 * messages from where the summary reached, including those no turn read.
 */
export const HISTORY_HARD_CAP = 2 * HISTORY_WINDOW_MAX;

/**
 * The most characters of history a turn sends before a fold, whatever its
 * count: about 75,000 tokens, which leaves room in the smallest context the
 * supported models have for the prompt, the tools and the turn. A few rows that
 * carry tool results replayed whole or pasted documents reach it well before
 * twenty messages; past the model's context the turn fails before its fold,
 * and so would every next one.
 */
export const HISTORY_CHAR_BUDGET = 300_000;

/** A history row as the fold sees it: when it was written and what it sends. */
type WindowRow = { createdAt: Date | null; content?: string; steps?: unknown; exactReplay?: unknown };

/** The characters a row sends: its text, and its steps or exact messages when the history replays them. */
function rowChars(row: WindowRow): number {
  return (
    (row.content?.length ?? 0) +
    (row.steps ? JSON.stringify(row.steps).length : 0) +
    (row.exactReplay ? JSON.stringify(row.exactReplay).length : 0)
  );
}

/**
 * How many of `window`'s oldest messages to fold into the summary once this
 * turn has added `added` more: zero until the window would exceed
 * {@link HISTORY_WINDOW_MAX} messages or already exceeds
 * {@link HISTORY_CHAR_BUDGET} characters. Past the count, all but the last
 * {@link HISTORY_KEPT_AFTER_FOLD} are folded; past the size, at least enough
 * that what stays fits in half of it. The fold never ends between two messages
 * stamped with the same instant, because the next history starts strictly
 * after the last folded one; it keeps one more message instead.
 */
export function messagesToFold(window: readonly WindowRow[], added: number): number {
  const sizes = window.map(rowChars);
  const total = sizes.reduce((sum, n) => sum + n, 0);
  const overCount = window.length + added > HISTORY_WINDOW_MAX;
  if (!overCount && total <= HISTORY_CHAR_BUDGET) return 0;
  let fold = overCount ? Math.min(window.length, window.length + added - HISTORY_KEPT_AFTER_FOLD) : 0;
  if (total > HISTORY_CHAR_BUDGET) {
    let kept = sizes.slice(fold).reduce((sum, n) => sum + n, 0);
    while (fold < window.length && kept > HISTORY_CHAR_BUDGET / 2) kept -= sizes[fold++];
  }
  while (fold > 0 && fold < window.length && sameInstant(window[fold - 1].createdAt, window[fold].createdAt)) fold--;
  // A row without a timestamp cannot mark where the next history starts.
  while (fold > 0 && !window[fold - 1].createdAt) fold--;
  return fold;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a !== null && b !== null && a.getTime() === b.getTime();
}
