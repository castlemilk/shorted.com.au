"use client";

import { useEffect, type RefObject } from "react";

// The air left between a docked bar and a control scrolled clear of it.
const FOCUS_AIR = 8;

// Surfaces that sit over the page wherever it is scrolled to, so scrolling the
// page cannot clear a control on them.
const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';

// The site's own header: a <header> outside <main>, stuck to the top. A <header>
// inside <main> is content.
function inSiteHeader(el: Element): boolean {
  const header = el.closest("header");
  return header !== null && header.closest("main") === null;
}

// `el` or an ancestor stays where it is on screen whatever the page scrolls to:
// position: fixed, or position: sticky and stuck at its sticky top (the site
// header, the docked stock tab bar, a stuck table head). Scrolling cannot clear
// a control there, and trying moves the page under the visitor for nothing. A
// sticky element that is not stuck is still in the flow, and scrolls.
function isPinned(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.position === "fixed") return true;
    if (style.position === "sticky") {
      const stickyTop = parseFloat(style.top);
      if (Number.isFinite(stickyTop) && Math.abs(node.getBoundingClientRect().top - stickyTop) <= 1) {
        return true;
      }
    }
  }
  return false;
}

// An engine without :focus-visible throws on the selector. There the browser's
// own scroll stands, as it did before this nudge existed.
function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * WCAG 2.2 SC 2.4.11, Focus Not Obscured: how far to scroll the page (a
 * negative number, up) to bring a control that has just taken focus out from
 * under a bar docked at the top of the screen, or 0 to leave the page alone.
 *
 * The bars are translucent and blurred, so a control left under one is an
 * unreadable smear with no visible focus ring. The browser does not help: it
 * scrolls a focus target into view only when the target is outside the
 * viewport, and the bar is inside it. It centres a control that is off screen,
 * so those are left to it.
 *
 * Only a control the visitor reaches with the keyboard moves the page
 * (:focus-visible), only while the bar is docked at its sticky top (nothing
 * sits under it otherwise; `fallbackTop` when that top cannot be read), and
 * never one that scrolling cannot clear: the bar's own controls, the site
 * header's, a dialog, anything fixed or stuck. A control beside the bar rather
 * than under it (the signed-in sidebar) is not obscured by it.
 */
function scrollToClear(bar: HTMLElement, control: Element, fallbackTop: number): number {
  if (bar.contains(control)) return 0;
  const box = bar.getBoundingClientRect();
  const parsedTop = parseFloat(getComputedStyle(bar).top);
  const stickyTop = Number.isFinite(parsedTop) ? parsedTop : fallbackTop;
  if (Math.abs(box.top - stickyTop) > 1) return 0;

  const rect = control.getBoundingClientRect();
  const clearTop = box.bottom + FOCUS_AIR;
  if (rect.top >= clearTop || rect.bottom <= 0) return 0;
  if (rect.right <= box.left || rect.left >= box.right) return 0;

  if (!isFocusVisible(control)) return 0;
  if (inSiteHeader(control)) return 0;
  if (control.closest(OVER_THE_PAGE) !== null) return 0;
  if (isPinned(control)) return 0;
  return rect.top - clearTop;
}

/**
 * Keeps keyboard focus out from under `bar` (see scrollToClear) while the
 * component that owns it is mounted. The site header and the stock page's tab
 * bar each run one; on a stock page the header's moves a control clear of
 * itself and the tab bar's then clear of the bar, and both read the boxes
 * afresh, so the two never add up to more than the lower bar needs.
 *
 * Not CSS `scroll-padding-top`: it makes Tab across a docked bar's own links
 * scroll the page to the top (the sticky bar can never sit below the padded
 * region, so the browser keeps scrolling to try), and it reaches no further
 * than a control the browser was already going to scroll.
 */
export function useFocusClearance(bar: RefObject<HTMLElement>, fallbackTop: number): void {
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const el = bar.current;
      const control = event.target;
      if (!el || !(control instanceof Element)) return;
      const delta = scrollToClear(el, control, fallbackTop);
      if (delta !== 0) window.scrollBy({ top: delta });
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [bar, fallbackTop]);
}
