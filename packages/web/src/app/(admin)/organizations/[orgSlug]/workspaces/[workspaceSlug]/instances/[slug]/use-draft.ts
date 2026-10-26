// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * The editable copy of a saved record, for a form that feeds `usePageSaveAction`.
 *
 * `draft` is the baseline with the user's edits on top; `isDirty` is true while
 * any field differs from the baseline. When the baseline itself changes (the
 * parent reloaded the agent, or this form's own save came back) the edits are
 * dropped, so the form shows the new saved values without an effect copying them
 * across, and the Save button goes quiet because nothing differs any more.
 */
export function useDraft<T extends object>(baseline: T) {
  const baselineKey = JSON.stringify(baseline);
  const [state, setState] = useState<{ key: string; edits: Partial<T> }>({ key: baselineKey, edits: {} });
  // A baseline that changed drops the stored edits for good (not just hides them), so a
  // baseline that later returns to a former value does not bring them back.
  if (state.key !== baselineKey) setState({ key: baselineKey, edits: {} });
  const edits: Partial<T> = state.key === baselineKey ? state.edits : (NO_EDITS as Partial<T>);

  const draft = useMemo(() => ({ ...baseline, ...edits }), [baseline, edits]);
  const isDirty = (Object.keys(edits) as (keyof T)[]).some(
    (field) => JSON.stringify(edits[field]) !== JSON.stringify(baseline[field]),
  );

  const set = useCallback(
    <K extends keyof T>(field: K, value: T[K]) =>
      setState((prev) => ({
        key: baselineKey,
        edits: { ...(prev.key === baselineKey ? prev.edits : {}), [field]: value },
      })),
    [baselineKey],
  );

  return { draft, set, isDirty };
}

const NO_EDITS = {};
