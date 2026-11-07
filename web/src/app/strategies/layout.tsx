import type { ReactNode } from "react";
import "~/@/components/gamma/gamma-bridge.css";
import "~/@/components/gamma/gamma.css";
import { StrategiesSubNav } from "~/@/components/strategies/strategies-sub-nav";

/**
 * The strategy workspace: the sub-navigation under the site header,
 * then each page. A profile route keeps its own tab bar as the one sticky bar.
 *
 * Reads no searchParams, cookies, headers or auth(): the sub-nav is a client
 * island that reads the pathname itself, so every route beneath stays ISR.
 *
 * The Gamma stylesheets are class-scoped (gamma-bridge.css maps their tokens onto
 * the house theme). They are imported here for the explorer's rail sheet
 * (SideSheet, below lg), as app/ownership/layout.tsx does.
 */
export default function StrategiesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <StrategiesSubNav />
      {children}
    </div>
  );
}
