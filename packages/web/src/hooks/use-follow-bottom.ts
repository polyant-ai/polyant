// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Within this distance of the bottom the reader counts as following. */
const FOLLOW_THRESHOLD_PX = 160;

/**
 * Keep a scroll container pinned to its bottom while `active`, each time
 * `content` changes, unless the reader has scrolled up to read something older.
 *
 * Whether the reader is following is decided when THEY scroll, never after new
 * content arrived. Measured afterwards, the distance from the bottom already
 * includes the new content: an answer taller than the threshold read as "the
 * reader scrolled up", and the view stopped following exactly when a long
 * reply or a block of tool steps came in.
 *
 * Turning `active` on re-pins to the bottom. An image that finishes loading
 * while following re-pins too, since it grows the content after the render.
 */
export function useFollowBottom(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  content: unknown,
): void {
  const followingRef = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
      // Only a move UP stops following. The scroll event of our own pin is
      // dispatched a frame later, and streamed content may have grown in
      // between: measured then, the pin itself looked like the reader leaving.
      if (nearBottom) followingRef.current = true;
      else if (el.scrollTop < lastTop) followingRef.current = false;
      lastTop = el.scrollTop;
    };
    // `load` does not bubble, so it is caught on the way down.
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement && followingRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("load", onLoad, true);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("load", onLoad, true);
    };
  }, [ref, active]);

  useLayoutEffect(() => {
    if (active) followingRef.current = true;
  }, [active]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active || !followingRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [ref, active, content]);
}
