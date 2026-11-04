import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A workspace page (spec 14.1): the main column and the inspector's rail. From
 * `lg` the page is a two-column grid, `minmax(0,1fr) 320px` with a 1 px rule
 * between; below `lg` the inspector is a sheet over the page, so its column has no
 * padding and takes no room (the rail is hidden by CSS, the sheet is a dialog).
 *
 * The inspector is a named slot, not a layout slot: the layout cannot know a
 * page's resolver, and a parallel route would add a default.tsx to every page
 * that does not have one. A page passes `<Inspector resolve={...} />` here.
 */
export function WorkspacePage({
  children,
  inspector,
  className,
}: {
  children: ReactNode;
  inspector?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-workspace
      className={cn(
        "mx-auto w-full max-w-[1400px] lg:grid lg:grid-cols-[minmax(0,1fr)_320px]",
        className,
      )}
    >
      <div className="min-w-0 px-4 py-6 sm:px-8">{children}</div>
      {inspector ? (
        <div className="min-w-0 lg:border-l lg:border-border lg:py-6 lg:pl-6 lg:pr-8">{inspector}</div>
      ) : null}
    </div>
  );
}
