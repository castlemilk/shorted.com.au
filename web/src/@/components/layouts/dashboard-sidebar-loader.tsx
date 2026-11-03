"use client";

import dynamic from "next/dynamic";

// The sidebar of the dashboard layout, at the left of the page and above the
// fold. It uses client-side hooks (usePathname, useSession) that do not work
// during SSR, so it is loaded with ssr: false. Every dashboard page reaches this
// module (the stock layout included), and each downloaded the sidebar with its
// first load before, so the module starts that download as it runs in the
// browser, never on the server.
if (typeof window !== "undefined") {
  void import("~/@/components/ui/sidebar");
}

export const Sidebar = dynamic(
  () => import("~/@/components/ui/sidebar").then((mod) => ({ default: mod.Sidebar })),
  { ssr: false },
);
