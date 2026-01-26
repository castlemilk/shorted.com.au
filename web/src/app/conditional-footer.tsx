"use client";

import React from "react";
import { usePathname } from "next/navigation";
import SiteFooter from "~/@/components/ui/site-footer";

export function ConditionalFooter() {
  const pathname = usePathname();

  // Roadmap should take the full space below the nav bar.
  if (pathname.startsWith("/roadmap")) return null;

  return <SiteFooter />;
}


