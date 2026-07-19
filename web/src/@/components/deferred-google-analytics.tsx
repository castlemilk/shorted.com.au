"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Idle-deferred GA4 loader.
 *
 * Replaces @next/third-parties' <GoogleAnalytics>, which injects the 152KB-gz
 * gtag.js with strategy="afterInteractive" — putting it in the Lighthouse LCP
 * dependency graph and main-thread window on every page. Here the script is
 * injected only after the window `load` event + an idle callback, so it never
 * competes with first paint or hydration. Analytics semantics are preserved:
 * gtag() calls queue into dataLayer before the script arrives, and SPA
 * navigations send page_view via the pathname effect below (mirroring
 * @next/third-parties' route-change tracking).
 */
export function DeferredGoogleAnalytics({ gaId }: { gaId: string }) {
  const loaded = useRef(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    window.dataLayer = window.dataLayer ?? [];
    window.gtag = (...args: unknown[]) => {
      window.dataLayer!.push(args);
    };
    window.gtag("js", new Date());
    // send_page_view stays on: the initial page_view fires when gtag.js boots.
    window.gtag("config", gaId);

    const inject = () => {
      const s = document.createElement("script");
      s.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
      s.async = true;
      document.head.appendChild(s);
    };

    const onIdle = () => {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(inject, { timeout: 5000 });
      } else {
        setTimeout(inject, 2000);
      }
    };

    if (document.readyState === "complete") {
      onIdle();
    } else {
      window.addEventListener("load", onIdle, { once: true });
    }
  }, [gaId]);

  // SPA route changes: gtag.js only auto-sends page_view on boot, so emit one
  // per client-side navigation (skip the very first render — boot covers it).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const query = searchParams?.toString();
    window.gtag?.("event", "page_view", {
      page_path: query ? `${pathname}?${query}` : pathname,
    });
  }, [pathname, searchParams]);

  return null;
}
