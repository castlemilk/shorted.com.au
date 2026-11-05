"use client";

/**
 * The phone's fold of a workspace toolbar (spec 14.9): the toolbar's one row of labelled
 * controls, under an "Adjust view" disclosure below `sm`. From `sm` the row shows as it
 * is. A CLIENT module: only the live islands draw it, through the `fold` their toolbar
 * takes. The server's default view draws the row unfolded, so no client module is on
 * its import path (client-boundary.test.ts).
 *
 * The HTML carries `open`, so a desktop's first paint is the open row with no script;
 * below `sm` the content is hidden by CSS until the effect has run (`view-fold` in
 * globals.css reads `data-ready`), so a phone's first paint is the closed fold and the
 * first instrument does not jump up when the island mounts (the hub's plate and row once
 * moved the map by about 230px at 390, backlog D2). The effect then keeps the attribute
 * truthful and follows the viewport: a phone turned to landscape crosses `sm` and gets
 * its controls back, turned upright it folds again.
 */

import { useEffect, useRef, type ReactNode } from "react";

export const VIEW_DISCLOSURE_LABEL = "Adjust view";

/** The media query the fold follows: Tailwind's `sm`. */
export const VIEW_FOLD_QUERY = "(min-width: 640px)";

export function ViewDisclosure({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(VIEW_FOLD_QUERY);
    const follow = () => {
      el.open = mq.matches;
    };
    follow();
    // From here the attribute is the truth, and the CSS that hid the content stands down.
    el.dataset.ready = "";
    mq.addEventListener("change", follow);
    return () => mq.removeEventListener("change", follow);
  }, []);
  return (
    <details ref={ref} open className="view-fold group">
      <summary className="cursor-pointer text-xs text-primary underline-offset-4 hover:underline sm:hidden">
        {VIEW_DISCLOSURE_LABEL}
      </summary>
      <div className="mt-3 sm:mt-0">{children}</div>
    </details>
  );
}
