// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Within this distance of the bottom the reader counts as following. */
const FOLLOW_THRESHOLD_PX = 160;

/**
 * How softly a smooth follow closes in on the bottom: the time constant of an
 * exponential approach, so the view covers about two thirds of what is left in
 * this long and never overshoots, however fast the content grows.
 */
const SMOOTH_TIME_CONSTANT_MS = 110;

export interface FollowBottom {
  /** False once the reader has scrolled up, until they come back near the bottom. */
  following: boolean;
  /** Back to the bottom, following again. */
  jumpToBottom: () => void;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

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
 * With `smooth`, the view glides to the bottom instead of jumping, chasing it
 * frame by frame while a reply streams in; a reader asking for reduced motion
 * gets the jump. A wheel or a scroll upwards stops the chase at once, so the
 * view never fights the reader.
 *
 * Turning `active` on re-pins to the bottom. An image that finishes loading
 * while following re-pins too, since it grows the content after the render.
 */
export function useFollowBottom(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  content: unknown,
  { smooth = false }: { smooth?: boolean } = {},
): FollowBottom {
  const followingRef = useRef(true);
  const [following, setFollowingState] = useState(true);
  const frameRef = useRef<number | null>(null);
  const smoothRef = useRef(smooth);

  useLayoutEffect(() => {
    smoothRef.current = smooth;
  }, [smooth]);

  const setFollowing = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowingState(value);
  }, []);

  const stopChase = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const pin = useCallback(() => {
    const el = ref.current;
    if (!el || !followingRef.current) return;
    if (!smoothRef.current || prefersReducedMotion()) {
      stopChase();
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (frameRef.current !== null) return;
    // Tracked as a float: the browser rounds scrollTop, and a step smaller than
    // a pixel read back from it would never move.
    let position = el.scrollTop;
    let last = performance.now();
    const step = (now: number) => {
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      if (!followingRef.current) {
        frameRef.current = null;
        return;
      }
      if (Math.abs(target - position) < 0.5) {
        el.scrollTop = target;
        frameRef.current = null;
        return;
      }
      position += (target - position) * (1 - Math.exp(-Math.max(0, now - last) / SMOOTH_TIME_CONSTANT_MS));
      last = now;
      el.scrollTop = position;
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }, [ref, stopChase]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    let lastTop = el.scrollTop;
    const leave = () => {
      stopChase();
      if (followingRef.current) setFollowing(false);
    };
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
      // Only a move UP stops following. The scroll event of our own pin is
      // dispatched a frame later, and streamed content may have grown in
      // between: measured then, the pin itself looked like the reader leaving.
      if (nearBottom) {
        if (!followingRef.current) setFollowing(true);
      } else if (el.scrollTop < lastTop) leave();
      lastTop = el.scrollTop;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) leave();
    };
    // `load` does not bubble, so it is caught on the way down.
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement) pin();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("load", onLoad, true);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("load", onLoad, true);
      stopChase();
    };
  }, [ref, active, pin, setFollowing, stopChase]);

  // Turning `active` on starts over at the bottom. Adjusted during render, from
  // the previous value, rather than set in an effect that would render twice.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setFollowingState(true);
  }
  useLayoutEffect(() => {
    if (active) followingRef.current = true;
  }, [active]);

  useLayoutEffect(() => {
    if (active) pin();
  }, [active, content, pin]);

  const jumpToBottom = useCallback(() => {
    setFollowing(true);
    pin();
  }, [pin, setFollowing]);

  return { following: following || !active, jumpToBottom };
}
