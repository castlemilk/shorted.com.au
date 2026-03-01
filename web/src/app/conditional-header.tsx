"use client";

import { usePathname } from "next/navigation";
import SiteHeader from "~/@/components/ui/site-header";

export function ConditionalHeader() {
  const pathname = usePathname();

  // Embed routes should not show the header
  if (pathname.startsWith("/embed")) return null;

  return <SiteHeader />;
}
