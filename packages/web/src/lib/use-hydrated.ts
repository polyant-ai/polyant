// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False in the server-rendered HTML and during hydration, true once React has
 * attached its handlers. A form that only works through its `onSubmit` handler
 * uses it to stay unsubmittable until then: before hydration a click is the
 * browser's own submit, which reloads the page and loses what was typed.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
