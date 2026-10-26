"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { canCollectAnalytics } from "~/@/lib/analytics-host";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * The page's URL without the one-click `t` credential. The alert and newsletter
 * unsubscribe links carry a signed token in `t`, and a working token must never reach
 * a third party. Every other parameter, including UTM tags, is kept, because GA reads
 * campaign attribution from the landing URL.
 */
export function pageLocationWithoutToken(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("t");
  return url.toString();
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
    if (!canCollectAnalytics()) return;
    if (loaded.current) return;
    loaded.current = true;

    window.dataLayer = window.dataLayer ?? [];
    // MUST push the `arguments` object, not a rest-args array: gtag.js only
    // executes commands whose dataLayer entry is [object Arguments] and
    // silently ignores plain arrays. The arrow-function/rest-array version of
    // this stub shipped 2026-07-16 and zeroed out ALL GA hits (config never
    // ran, so no page_view or events fired) until fixed on 2026-07-25.
    const gtag = function () {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    } as NonNullable<Window["gtag"]>;
    window.gtag = gtag;
    window.gtag("js", new Date());
    // send_page_view stays on: the initial page_view fires when gtag.js boots, and
    // it reports the page without the one-click unsubscribe token.
    window.gtag("config", gaId, { page_location: pageLocationWithoutToken() });

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
    if (!canCollectAnalytics()) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.gtag?.("event", "page_view", {
      // Auth callback URLs and search strings must not become event params.
      page_path: pathname,
      page_location: `${window.location.origin}${pathname ?? "/"}`,
    });
  }, [pathname, searchParams]);

  return null;
}
