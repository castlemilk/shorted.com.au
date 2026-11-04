"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { WorkspaceSubNav } from "~/@/components/workspace/workspace-sub-nav";
import {
  STRATEGIES_GROUP,
  STRATEGIES_LABEL,
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
 * The pathname decides the active tab and whether the bar sticks. On a strategy's
 * own route, Signals links to that strategy, which the server knows from the
 * path, so the cached HTML is right without storage. Elsewhere Signals links to
 * the last strategy recorded; that is read after mount, so the first paint never
 * depends on this visitor's storage. Viewing a strategy records it.
 */
export function StrategiesSubNav() {
  const pathname = usePathname() ?? "";
  const [stored, setStored] = useState<string | null>(null);
  const viewing = strategyFromPath(pathname);

  useEffect(() => {
    if (viewing) rememberStrategy(viewing);
    setStored(readLastViewedStrategy());
  }, [viewing]);

  return (
    <WorkspaceSubNav
      group={STRATEGIES_GROUP}
      label={STRATEGIES_LABEL}
      tabs={resolveStrategiesTabs(viewing ?? stored)}
      activeTab={activeStrategiesTab(pathname)}
      sticky={!isStrategyProfilePath(pathname)}
    />
  );
}
