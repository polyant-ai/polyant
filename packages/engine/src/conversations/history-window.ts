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
 * {@link HISTORY_KEPT_AFTER_FOLD} is summarized once.
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
 * How many of `window`'s oldest messages to fold into the summary once this
 * turn has added `added` more: zero until the window would exceed
 * {@link HISTORY_WINDOW_MAX}. The fold never ends between two messages stamped
 * with the same instant, because the next history starts strictly after the
 * last folded one; it keeps one more message instead.
 */
export function messagesToFold(window: readonly { createdAt: Date | null }[], added: number): number {
  if (window.length + added <= HISTORY_WINDOW_MAX) return 0;
  let fold = Math.min(window.length, window.length + added - HISTORY_KEPT_AFTER_FOLD);
  while (fold > 0 && fold < window.length && sameInstant(window[fold - 1].createdAt, window[fold].createdAt)) fold--;
  // A row without a timestamp cannot mark where the next history starts.
  while (fold > 0 && !window[fold - 1].createdAt) fold--;
  return fold;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a !== null && b !== null && a.getTime() === b.getTime();
}
