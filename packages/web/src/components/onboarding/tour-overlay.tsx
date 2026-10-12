// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSidebar } from "@/components/ui/sidebar";
import { useI18n } from "@/lib/i18n/context";
import { useOnboarding } from "@/lib/onboarding/onboarding-context";
import { isOnTourPage, tourHref, tourSteps, type TourPlace } from "@/lib/onboarding/tours";
import { resolveNavScope } from "@/lib/tenant/nav-href";
import { useTenant } from "@/lib/tenant/tenant-context";

const PAD = 6;
const GUTTER = 16;
const GAP = 14;
/** How long to wait for a step's element before showing the bubble without a spotlight. */
const TARGET_TIMEOUT_MS = 5000;

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Where the bubble goes: the preferred side if it fits, then the others. */
export function placeBubble(
  box: Box | null,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  preferred: TourPlace,
  narrow: boolean,
): { x: number; y: number; side: TourPlace | null; docked?: boolean } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (!box) {
    return { x: (viewport.w - size.w) / 2, y: Math.max(GUTTER, (viewport.h - size.h) / 2), side: null };
  }
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  const tries: Record<TourPlace, () => { x: number; y: number; ok: boolean }> = {
    bottom: () => ({
      x: clamp(cx - size.w / 2, GUTTER, viewport.w - GUTTER - size.w),
      y: box.y2 + GAP,
      ok: box.y2 + GAP + size.h <= viewport.h - GUTTER,
    }),
    top: () => ({
      x: clamp(cx - size.w / 2, GUTTER, viewport.w - GUTTER - size.w),
      y: box.y1 - GAP - size.h,
      ok: box.y1 - GAP - size.h >= GUTTER,
    }),
    right: () => ({
      x: box.x2 + GAP,
      y: clamp(cy - size.h / 2, GUTTER, viewport.h - GUTTER - size.h),
      ok: box.x2 + GAP + size.w <= viewport.w - GUTTER,
    }),
    left: () => ({
      x: box.x1 - GAP - size.w,
      y: clamp(cy - size.h / 2, GUTTER, viewport.h - GUTTER - size.h),
      ok: box.x1 - GAP - size.w >= GUTTER,
    }),
  };
  // On a phone only above or below can fit.
  const order: TourPlace[] = narrow
    ? ["bottom", "top"]
    : [preferred, "bottom", "top", "right", "left"];
  for (const side of order) {
    const c = tries[side]();
    if (c.ok) return { x: c.x, y: c.y, side };
  }
  // Nowhere beside the element: on a phone the bubble docks as a bottom sheet and
  // the spotlight is clipped to what shows above it.
  if (narrow) return { x: GUTTER, y: viewport.h - GUTTER - size.h, side: null, docked: true };
  return {
    x: clamp(cx - size.w / 2, GUTTER, viewport.w - GUTTER - size.w),
    y: viewport.h - GUTTER - size.h,
    side: null,
  };
}

/**
 * The interface and agent tours: everything dimmed, a bubble anchored to the real
 * element. In-house rather than a library: the behaviour is one overlay and one
 * positioning function, it must cross pages and open the phone drawer, and both
 * are easier to own here than to bend a dependency around.
 */
export function TourOverlay() {
  const { t } = useI18n();
  const { tour, isPlatformAdmin, setTourIndex, endTour } = useOnboarding();
  const tenant = useTenant();
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const titleId = useId();
  const bodyId = useId();

  const steps = useMemo(
    () => (tour ? tourSteps(tour.kind, isPlatformAdmin) : []),
    [tour, isPlatformAdmin],
  );
  const step = tour ? steps[tour.index] : undefined;
  const scope = resolveNavScope(tenant, params);
  const orgSlug = scope.orgSlug;
  const workspaceSlug = scope.workspaceSlug;
  const agentSlug = tour?.agentSlug;
  const tab = searchParams.get("tab");

  const [box, setBox] = useState<Box | null>(null);
  const [settled, setSettled] = useState(false);
  const [bubble, setBubble] = useState<{ x: number; y: number; side: TourPlace | null; docked?: boolean } | null>(null);
  // Where the docked sheet starts, so the spotlight can stop above it.
  const [dockTop, setDockTop] = useState<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const stepKey = tour && step ? `${tour.kind}:${step.id}` : null;

  const last = !!tour && tour.index === steps.length - 1;
  const next = useCallback(() => {
    if (!tour) return;
    if (tour.index >= steps.length - 1) endTour("done");
    else setTourIndex(tour.index + 1);
  }, [tour, steps.length, endTour, setTourIndex]);
  const back = useCallback(() => {
    if (tour && tour.index > 0) setTourIndex(tour.index - 1);
  }, [tour, setTourIndex]);

  // 1. Be on the page the step needs.
  useEffect(() => {
    if (!step || !orgSlug || !workspaceSlug) return;
    const tourScope = { orgSlug, workspaceSlug, agentSlug };
    if (!isOnTourPage(step.page, tourScope, { pathname, tab })) {
      router.push(tourHref(step.page, tourScope));
    }
    // Navigates when the STEP changes; the person moving by hand mid-step is theirs to do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey, orgSlug, workspaceSlug]);

  // 2. On a phone the sidebar is a drawer: open it for a target inside it, close it otherwise.
  useEffect(() => {
    if (!isMobile) return;
    setOpenMobile(!!step?.inSidebar);
  }, [isMobile, step?.inSidebar, stepKey, setOpenMobile]);
  useEffect(() => {
    if (!tour && isMobile) setOpenMobile(false);
  }, [tour, isMobile, setOpenMobile]);

  // 3. Find the element and follow it while it moves.
  useEffect(() => {
    if (!step) return;
    setBox(null);
    setSettled(false);
    let scrolled = false;
    const started = Date.now();
    const measure = () => {
      const el = document.querySelector(step.target);
      const r = el?.getBoundingClientRect();
      if (el && r && r.width > 0 && r.height > 0) {
        if (!scrolled && !step.inSidebar) {
          scrolled = true;
          el.scrollIntoView({ block: "center", inline: "nearest" });
        }
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const next: Box = {
          x1: Math.max(0, r.left - PAD),
          y1: Math.max(0, r.top - PAD),
          x2: Math.min(vw, r.right + PAD),
          y2: Math.min(vh, r.bottom + PAD),
        };
        setBox((prev) =>
          prev && prev.x1 === next.x1 && prev.y1 === next.y1 && prev.x2 === next.x2 && prev.y2 === next.y2
            ? prev
            : next,
        );
        setSettled(true);
      } else {
        setBox((prev) => (prev ? null : prev));
        if (Date.now() - started > TARGET_TIMEOUT_MS) setSettled(true);
      }
    };
    measure();
    const timer = window.setInterval(measure, 150);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey]);

  // 4. A click on the highlighted element of a "click" step moves on.
  useEffect(() => {
    if (!step || step.action !== "click") return;
    const onClick = (event: MouseEvent) => {
      const el = event.target as Element | null;
      if (!el?.closest || el.closest("[data-tour-layer]")) return;
      if (el.closest(step.target)) window.setTimeout(next, 0);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [step, next]);

  // Place the bubble once its size is known, and again whenever the target moves.
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el || !step) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = Math.min(340, vw - 2 * GUTTER);
    el.style.width = `${w}px`;
    const placed = placeBubble(box, { w, h: el.offsetHeight }, { w: vw, h: vh }, step.place, vw < 768);
    setBubble(placed);
    if (placed.docked) {
      // The sheet spans the screen minus the gutters; its height follows the new width.
      el.style.width = `${vw - 2 * GUTTER}px`;
      setDockTop(el.getBoundingClientRect().top);
    } else {
      setDockTop(null);
    }
  }, [box, step, stepKey, settled]);

  // Focus the bubble when a step appears, so a screen reader announces it.
  useEffect(() => {
    if (stepKey) bubbleRef.current?.focus({ preventScroll: true });
  }, [stepKey, settled]);

  // Keyboard: Escape leaves, arrows move, Tab stays in the bubble (and the target of a click step).
  useEffect(() => {
    if (!step) return;
    const onKey = (event: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement | null)?.tagName ?? "");
      if (event.key === "Escape") {
        event.preventDefault();
        endTour("exit");
      } else if (event.key === "ArrowRight" && !typing && step.action === "info") {
        next();
      } else if (event.key === "ArrowLeft" && !typing) {
        back();
      } else if (event.key === "Tab" && bubbleRef.current) {
        const target = step.action === "click" ? document.querySelector<HTMLElement>(step.target) : null;
        const own = Array.from(bubbleRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
        const ring = target ? [...own, target] : own;
        if (ring.length === 0) return;
        const at = ring.indexOf(document.activeElement as HTMLElement);
        const nextAt = event.shiftKey ? (at <= 0 ? ring.length - 1 : at - 1) : at === ring.length - 1 ? 0 : at + 1;
        event.preventDefault();
        ring[nextAt].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, next, back, endTour]);

  if (!tour || !step || typeof document === "undefined") return null;

  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const panel = (key: string, l: number, tp: number, w: number, h: number) => (
    <div
      key={key}
      className="fixed bg-black/60"
      style={{ left: l, top: tp, width: Math.max(0, w), height: Math.max(0, h) }}
    />
  );
  const click = step.action === "click";
  // A docked sheet covers the bottom of the screen: the spotlight keeps to what is above it.
  const lit =
    box && bubble?.docked && dockTop !== null
      ? { ...box, y2: Math.max(box.y1 + 24, Math.min(box.y2, dockTop - 8)) }
      : box;

  return createPortal(
    // Above sonner's toaster (z-index 999999999): a toast must never cover the bubble's buttons.
    <div data-tour-layer className="fixed inset-0" style={{ pointerEvents: "none", zIndex: 2147483000 }}>
      <div aria-hidden style={{ pointerEvents: "auto" }}>
        {lit ? (
          <>
            {panel("t", 0, 0, vw, lit.y1)}
            {panel("b", 0, lit.y2, vw, vh - lit.y2)}
            {panel("l", 0, lit.y1, lit.x1, lit.y2 - lit.y1)}
            {panel("r", lit.x2, lit.y1, vw - lit.x2, lit.y2 - lit.y1)}
            <div
              className="pointer-events-none fixed rounded-lg border-2 border-primary"
              style={{ left: lit.x1, top: lit.y1, width: lit.x2 - lit.x1, height: lit.y2 - lit.y1 }}
            />
            {/* An info step is looked at, not used: the hole swallows clicks. */}
            {!click && (
              <div
                className="fixed"
                style={{ left: lit.x1, top: lit.y1, width: lit.x2 - lit.x1, height: lit.y2 - lit.y1 }}
              />
            )}
          </>
        ) : (
          panel("all", 0, 0, vw, vh)
        )}
      </div>
      <div
        ref={bubbleRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="fixed rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
        style={{
          ...(bubble?.docked
            ? { left: GUTTER, right: GUTTER, bottom: "calc(16px + env(safe-area-inset-bottom))" }
            : { left: bubble?.x ?? 0, top: bubble?.y ?? 0 }),
          visibility: bubble && settled ? "visible" : "hidden",
          pointerEvents: "auto",
        }}
      >
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span>{t("onboarding.tour.progress", { current: tour.index + 1, total: steps.length })}</span>
          {click && <Badge variant="secondary">{t("onboarding.tour.clickBadge")}</Badge>}
        </div>
        <h2 id={titleId} className="mt-1 text-base font-semibold">
          {t(step.titleKey)}
        </h2>
        <p id={bodyId} className="mt-1 text-sm text-muted-foreground">
          {t(step.bodyKey)}
        </p>
        {click && <p className="mt-2 text-xs text-muted-foreground">{t("onboarding.tour.clickHint")}</p>}
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => endTour("exit")}>
            {t("onboarding.tour.exit")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={back} disabled={tour.index === 0}>
              {t("onboarding.tour.back")}
            </Button>
            {click ? (
              <Button variant="ghost" size="sm" onClick={next}>
                {t("onboarding.tour.skipStep")}
              </Button>
            ) : (
              <Button size="sm" onClick={next}>
                {last ? t("onboarding.tour.done") : t("onboarding.tour.next")}
              </Button>
            )}
          </div>
        </div>
        <button
          type="button"
          className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => endTour("never")}
        >
          {t("onboarding.never")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
