import { RegimePill } from "~/@/components/picks/regime-banner";
import { shortDayLabel } from "~/@/lib/strategies/evidence";
import type {
  MarketRegimeView,
  StrategyVersionDef,
} from "~/@/lib/strategies/types";

/**
 * The Signals tab's provenance line: the price date, the ASIC report and when it
 * became public, the rules version, and the index regime. A delayed snapshot says
 * so in words. The figures are the API's; nothing here is derived.
 */
export function SignalsProvenance({
  asOf,
  shortReportDate,
  shortAvailableDate,
  version,
  stale,
  regime,
}: {
  asOf: string;
  shortReportDate?: string;
  shortAvailableDate?: string;
  version?: StrategyVersionDef;
  stale: boolean;
  regime: MarketRegimeView | null;
}) {
  const price = shortDayLabel(asOf);
  const report = shortDayLabel(shortReportDate);
  const available = shortDayLabel(shortAvailableDate);
  const rules = version?.label
    ? `Rules ${version.label}${version.rulesHash ? ` · ${version.rulesHash.slice(0, 8)}` : ""}`
    : "";
  const facts = [
    stale
      ? `Data delayed: showing ${price || "an earlier session"}. Today's update is still running.`
      : price
        ? `Prices: ${price}`
        : "",
    report
      ? `ASIC report ${report}${available ? `, available ${available}` : ""}`
      : "",
    rules,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-border/60 bg-card px-3 py-2 text-xs text-muted-foreground">
      <p>
        {facts.map((fact, index) => (
          <span key={fact}>
            {index > 0 ? " · " : null}
            {fact}
          </span>
        ))}
      </p>
      {regime ? <RegimePill regime={regime.regime} /> : null}
    </div>
  );
}
