// The strategy workspace's capability flags (the capability registry). A flag
// turns on in the same change that ships the capability it names, so no
// Compare, Create alert, Alert-me or variant control renders before its route
// and its API work exist. Every CTA, deep link and capability sheet reads a
// flag here before it renders.
//
// Every flag is off until its capability ships:
//   compare        the Compare tray and /strategies/compare (PR-20)
//   alertBuilder   the alert builder (Save draft only)
//   alertEnable    "Save & enable" for strategy alerts
//   alertEmail     the Email delivery checkbox
//   trackedEntries "Track this entry" and tracked entries
//   variants       "Edit a copy" and variant backtests
//   saves          "Save" on a strategy and the My strategies list (signed-in only)

export const STRATEGY_CAPABILITY_NAMES = [
  "compare",
  "alertBuilder",
  "alertEnable",
  "alertEmail",
  "trackedEntries",
  "variants",
  "saves",
] as const;

export type StrategyCapability = (typeof STRATEGY_CAPABILITY_NAMES)[number];

export const STRATEGY_CAPABILITIES: Record<StrategyCapability, boolean> = {
  compare: true,
  alertBuilder: false,
  alertEnable: false,
  alertEmail: false,
  trackedEntries: false,
  variants: false,
  saves: true,
};

export function strategyCapabilityEnabled(name: StrategyCapability): boolean {
  return STRATEGY_CAPABILITIES[name] === true;
}
