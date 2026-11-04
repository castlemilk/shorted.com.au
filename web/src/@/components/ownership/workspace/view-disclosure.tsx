"use client";

/**
 * The phone's fold of a workspace toolbar (spec 14.9): the toolbar's one row of labelled
 * controls, under an "Adjust view" disclosure below `sm`. From `sm` the row shows as it
 * is. A CLIENT module: only the live islands draw it, through the `fold` their toolbar
 * takes. The server's default view draws the row unfolded, so no client module is on
 * its import path (client-boundary.test.ts).
 *
 * It opens on a desktop and closes itself on a phone once mounted.
 */

import { useEffect, useRef, type ReactNode } from "react";

export const VIEW_DISCLOSURE_LABEL = "Adjust view";

export function ViewDisclosure({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && typeof window !== "undefined" && !window.matchMedia?.("(min-width: 640px)").matches) {
      el.open = false;
    }
  }, []);
  return (
    <details ref={ref} open className="group">
      <summary className="cursor-pointer text-xs text-primary underline-offset-4 hover:underline sm:hidden">
        {VIEW_DISCLOSURE_LABEL}
      </summary>
      <div className="mt-3 sm:mt-0">{children}</div>
    </details>
  );
}
