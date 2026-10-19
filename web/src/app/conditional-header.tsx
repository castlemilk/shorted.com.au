"use client";

import { usePathname } from "next/navigation";
import SiteHeader from "~/@/components/ui/site-header";

export function ConditionalHeader() {
  const pathname = usePathname();

  // Embed routes should not show the header
  if (pathname.startsWith("/embed")) return null;

  // Nor the chart share page (/chart/<code>): the chart is the page, and it
  // carries its own bar back to the stock. Slash-scoped, like /oauth/.
  if (pathname.startsWith("/chart/")) return null;

  // Nor should the OAuth flow. A consent screen is a decision, and site
  // navigation beside it is an invitation to wander off mid-authorisation —
  // which is why Google, GitHub and Slack all render theirs without chrome.
  // The screen carries its own Shorted mark, so the brand cue survives.
  if (pathname.startsWith("/oauth/")) return null;

  return <SiteHeader />;
}
