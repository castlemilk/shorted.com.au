"use client";

import { useEffect, useState } from "react";

import { cn } from "~/@/lib/utils";

export interface NarrativeRailItem {
  id: string;
  label: string;
}

/**
 * Sticky narrative rail for the industry intelligence story. Renders as a
 * left-hand sticky column on xl+ and a horizontal scroll-snap chip row on
 * smaller screens. Items are anchors into page sections; the active section is
 * tracked with an IntersectionObserver and marked with aria-current.
 *
 * Only sections that exist (live data) should be passed in — the rail never
 * advertises an empty channel.
 */
export function IndustryNarrativeRail({
  items,
  className,
}: {
  items: NarrativeRailItem[];
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-25% 0px -60% 0px", threshold: [0, 0.25, 0.5] },
    );
    for (const item of items) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Story sections"
      className={cn("min-w-0", className)}
      data-testid="industry-narrative-rail"
    >
      <ol className="flex snap-x gap-1.5 overflow-x-auto pb-1 xl:flex-col xl:gap-1 xl:overflow-visible xl:pb-0">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id} className="snap-start">
              <a
                href={`#${item.id}`}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex min-h-10 items-center whitespace-nowrap rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  active
                    ? "border-primary/40 bg-primary/10 font-medium text-primary"
                    : "border-transparent text-muted-foreground hover:border-border/60 hover:text-foreground",
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
