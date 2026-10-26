"use client";

import { isChromelessRoute } from "~/@/lib/chromeless-routes";
import { usePathname } from "next/navigation";
import SiteHeader from "~/@/components/ui/site-header";

export function ConditionalHeader() {
  const pathname = usePathname();

  // Chrome-less routes (embed, chart share, OAuth consent) render no header. The list
  // lives in @/lib/chromeless-routes, shared with every banner.
  if (isChromelessRoute(pathname)) return null;

  return <SiteHeader />;
}
