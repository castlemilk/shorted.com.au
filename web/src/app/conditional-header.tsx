"use client";

import { isChromelessRoute } from "~/@/lib/chromeless-routes";
import { usePathname } from "next/navigation";
import SiteHeader from "~/@/components/ui/site-header";

export function ConditionalHeader() {
  const pathname = usePathname();

  // Chrome-less routes (embed, chart share, OAuth consent) render no header. The list
  // lives in @/lib/chromeless-routes, shared with every banner.
  if (isChromelessRoute(pathname)) return null;

  return (
    <>
      {pathname?.startsWith("/ownership/traders/") && (
        <a
          href="#investor-filings"
          className="hidden sr-only [body:has(#investor-filings)_&]:block focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:border focus:bg-background focus:px-4 focus:py-2 focus:text-primary focus:outline focus:outline-2 focus:outline-ring"
        >
          Skip to filings
        </a>
      )}
      <SiteHeader />
    </>
  );
}
