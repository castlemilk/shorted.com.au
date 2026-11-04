"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { WorkspaceSubNav } from "~/@/components/workspace/workspace-sub-nav";
import {
  STRATEGIES_GROUP,
  activeStrategiesTab,
  isStrategyProfilePath,
  readLastViewedStrategy,
  rememberStrategy,
  resolveStrategiesTabs,
  strategyFromPath,
} from "~/@/lib/strategies/workspace-nav";

/**
 * The strategy workspace's sub-navigation, rendered by app/strategies/layout.tsx.
 *
 * The pathname decides the active tab and whether the bar sticks. Viewing a
 * strategy records it, and Signals links to the last one recorded. The server
 * renders Signals for the default strategy; the stored one is read after mount,
 * so the first paint never depends on this visitor's storage.
 */
export function StrategiesSubNav() {
  const pathname = usePathname() ?? "";
  const [lastViewed, setLastViewed] = useState<string | null>(null);

  useEffect(() => {
    const viewing = strategyFromPath(pathname);
    if (viewing) rememberStrategy(viewing);
    setLastViewed(viewing ?? readLastViewedStrategy());
  }, [pathname]);

  return (
    <WorkspaceSubNav
      group={STRATEGIES_GROUP}
      tabs={resolveStrategiesTabs(lastViewed)}
      activeTab={activeStrategiesTab(pathname)}
      sticky={!isStrategyProfilePath(pathname)}
    />
  );
}
