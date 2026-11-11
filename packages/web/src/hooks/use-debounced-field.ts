// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A text field that shows every keystroke at once and hands its text to
 * `onCommit` only once typing has paused for `delayMs`, so whatever the
 * committed text drives (a request, the URL) changes once per pause.
 *
 * `value` is the committed text as the owner holds it. A change to it from
 * elsewhere (a cleared filter, the back button) replaces the field's text, but
 * not while an edit is waiting to be committed or on its way to the owner: an
 * owner that takes a render or two to pass the commit back (a URL update)
 * would otherwise put an older text back under the cursor and lose what was
 * typed meanwhile. The edit is settled once `value` equals the field.
 *
 * `onCommit` is read when the pause ends, so it may change on every render
 * without restarting the wait.
 */
export function useDebouncedField(
  value: string,
  onCommit: (next: string) => void,
  delayMs: number,
): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value);
  // An edit that `value` does not show yet: committed or about to be.
  const [pending, setPending] = useState(false);
  const [seen, setSeen] = useState(value);

  if (value !== seen) {
    setSeen(value);
    if (!pending) setDraft(value);
  }
  if (pending && value === draft) setPending(false);

  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => commit.current(draft), delayMs);
    return () => clearTimeout(timer);
  }, [draft, pending, delayMs]);

  const change = useCallback((next: string) => {
    setDraft(next);
    setPending(true);
  }, []);

  return [draft, change];
}
