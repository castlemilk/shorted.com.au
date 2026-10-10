"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cn, isPlainLeftClick } from "~/@/lib/utils";
import {
  STOCK_TABS,
  activeStockTab,
  stockTabHref,
} from "~/@/lib/stocks/stock-tabs";

// The bar is rendered on the server too, where a layout effect only warns.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

// The bar's `top-16`, for when its computed top cannot be read as a number.
const DEFAULT_STICKY_TOP = 64;

/**
 * The stock page's tab bar: seven plain links (crawlable, SSR'd by the server
 * layout that renders this). Prefetch is INTENT-driven — pointer enter, touch
 * start or focus, once per href — never on viewport entry: seven viewport
 * prefetches per page view would quietly regenerate seven ISR routes.
 *
 * The bar is sticky under the site header (`top-16` = its h-16 row), so a tab
 * switch has to leave the page where the new tab starts under the bar. Next
 * 14.2 cannot be trusted to do that: its handler does nothing when the new
 * segment's first node is inside the viewport (the new tab's first ~110px then
 * sit under the two bars) and jumps to the top when it is above. So the links
 * pass `scroll={false}` and this component scrolls, see the layout effect.
 */
export function StockTabNav({ stockCode }: { stockCode: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeStockTab(pathname ?? "");
  const prefetched = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Set by a click on a tab, consumed when the active tab changes. Back and
  // forward change the tab without it, and keep the scroll the browser restores.
  const pendingClick = useRef(false);
  const mounted = useRef(false);

  const warm = useCallback(
    (href: string, isActive: boolean) => {
      if (isActive || prefetched.current.has(href)) return;
      prefetched.current.add(href);
      router.prefetch(href);
    },
    [router],
  );

  // Seven triggers overflow on a phone: keep the active one in view. offsetLeft
  // is measured from the nearest POSITIONED ancestor, while scrollLeft and
  // clientWidth belong to the list itself, so the list below is `relative`.
  // Unpositioned, the target also carries the list's own offset inside some
  // farther ancestor and the scroll overshoots (at 390px a mid-list tab landed
  // 16px outside the bar).
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !el) return;
    if (
      el.offsetLeft + el.offsetWidth > list.scrollLeft + list.clientWidth ||
      el.offsetLeft < list.scrollLeft
    ) {
      list.scrollTo({ left: el.offsetLeft - 16 });
    }
  }, [active]);

  // After a click on a tab, put the page where the new tab starts directly
  // under the docked bar. The sentinel is the bar's place in the flow: while
  // the bar is docked it is above the viewport, and `dockY` is the scroll
  // position at which the bar just reaches its sticky top. Only a page scrolled
  // past that moves, to exactly there; a bar that was not docked stays where it
  // was. Layout effect, so the scroll lands in the commit that shows the tab
  // and the old position never paints under the new content.
  useIsomorphicLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!pendingClick.current) return;
    pendingClick.current = false;

    const sentinel = sentinelRef.current;
    const nav = navRef.current;
    if (!sentinel || !nav) return;
    const stickyTop = parseFloat(getComputedStyle(nav).top) || DEFAULT_STICKY_TOP;
    const dockY = sentinel.getBoundingClientRect().top + window.scrollY - stickyTop;
    if (window.scrollY > dockY + 1) {
      window.scrollTo({ top: dockY, left: window.scrollX });
    }
  }, [active]);

  return (
    <>
      {/* Zero height and in flow: where the bar sits before it docks. */}
      <div ref={sentinelRef} aria-hidden="true" className="h-0" />
      <nav
        ref={navRef}
        aria-label="Stock sections"
        className="sticky top-16 z-30 -mx-8 mb-4 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75"
      >
        {/* The bar bleeds to main's edges with -mx-8, and the 2rem it gives back
            is padding on the LIST, not on the bar. On a phone the overflowing
            tabs then scroll to the screen's edge and the next one peeks out,
            which is what shows the bar scrolls. `scroll-px-8` keeps that
            margin when the browser scrolls a focused tab into view. The
            scrollbar is hidden because the row has no height to spare for it. */}
        <div
          ref={listRef}
          className="relative flex h-11 scroll-px-8 items-stretch gap-1 overflow-x-auto px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {STOCK_TABS.map((tab) => {
            const href = stockTabHref(stockCode, tab.id);
            const isActive = tab.id === active;
            return (
              <Link
                key={tab.id}
                href={href}
                prefetch={false}
                scroll={false}
                aria-current={isActive ? "page" : undefined}
                onClick={(e) => {
                  // Only a click that will change the tab. A modified click opens
                  // another window, and the active tab is not a navigation.
                  if (!isActive && isPlainLeftClick(e)) pendingClick.current = true;
                }}
                onPointerEnter={() => warm(href, isActive)}
                onTouchStart={() => warm(href, isActive)}
                onFocus={() => warm(href, isActive)}
                className={cn(
                  // The ring is drawn inside the link: the list scrolls, so it
                  // clips anything outside the links, which fill its height.
                  "relative inline-flex shrink-0 items-center px-3 font-mono text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isActive
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {isActive ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-primary"
                  />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
