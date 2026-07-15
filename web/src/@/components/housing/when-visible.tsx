"use client";

import type { ReactNode } from "react";

import { useWidgetVisibility } from "@/hooks/use-widget-visibility";

/**
 * Defers mounting `children` until the container scrolls near the viewport.
 *
 * Used to keep below-the-fold client chunks (visx/d3 charts + their connect-web
 * fetches) off the post-hydration critical path for visitors who never scroll.
 * The children are only *created* as React elements on the server — a
 * dynamic(ssr:false) child does not request its chunk until it actually mounts,
 * so gating the render gates the download + the RPC round-trip.
 *
 * `minHeightClassName` MUST match the eventual content height (e.g. the chart's
 * own 280px loading skeleton) so the on-scroll mount causes no layout shift.
 */
export function WhenVisible({
  children,
  minHeightClassName = "h-[280px]",
  rootMargin = "300px",
}: {
  children: ReactNode;
  minHeightClassName?: string;
  rootMargin?: string;
}) {
  const { ref, hasBeenVisible } = useWidgetVisibility({ rootMargin });

  return (
    <div ref={ref}>
      {hasBeenVisible ? (
        children
      ) : (
        <div
          className={`w-full animate-pulse rounded bg-muted ${minHeightClassName}`}
          aria-hidden
        />
      )}
    </div>
  );
}
