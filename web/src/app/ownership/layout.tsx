import type { ReactNode } from "react";
import "~/@/components/gamma/gamma-bridge.css";
import "~/@/components/gamma/gamma.css";
import "~/@/components/gamma/DataTable.css";
import { OwnershipNav } from "~/@/components/ownership/workspace/ownership-nav";

/**
 * The ownership workspace (spec 14.1): the sub-navigation under the site header,
 * then each page. The Gamma stylesheets load here once, for every workspace page.
 * Pages lay out their own main column and inspector with WorkspacePage.
 *
 * Reads no searchParams, cookies, headers or auth(): the nav is a client island
 * that reads the pathname itself.
 */
export default function OwnershipLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <OwnershipNav />
      {children}
    </div>
  );
}
