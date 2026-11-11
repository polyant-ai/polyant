// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How long a closed stream has to reopen before it is shown as lost. The server
 * closes a long-lived stream on purpose and the browser reopens it by itself a
 * few seconds later; only a stream that stays closed past this is a lost
 * connection.
 */
export const RECONNECT_GRACE_MS = 10_000;

/**
 * Report whether an `EventSource` is connected, without reporting the close the
 * browser recovers from on its own: `onChange(true)` on every open, and
 * `onChange(false)` only when an error is not followed by an open within
 * `RECONNECT_GRACE_MS`. Call the returned function when closing the source.
 */
export function watchConnection(source: EventSource, onChange: (connected: boolean) => void): () => void {
  let lost: ReturnType<typeof setTimeout> | undefined;
  source.onopen = () => {
    clearTimeout(lost);
    lost = undefined;
    onChange(true);
  };
  source.onerror = () => {
    lost ??= setTimeout(() => onChange(false), RECONNECT_GRACE_MS);
  };
  return () => clearTimeout(lost);
}
