import type { ReactNode } from "react";
import { StrategiesSubNav } from "~/@/components/strategies/strategies-sub-nav";

/**
 * The strategy workspace: the sub-navigation under the site header,
 * then each page. A profile route keeps its own tab bar as the one sticky bar.
 *
 * Reads no searchParams, cookies, headers or auth(): the sub-nav is a client
 * island that reads the pathname itself, so every route beneath stays ISR.
 */
export default function StrategiesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <StrategiesSubNav />
      {children}
    </div>
  );
}
