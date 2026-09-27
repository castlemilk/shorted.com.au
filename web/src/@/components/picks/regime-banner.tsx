import { cn } from "~/@/lib/utils";
import { eyebrow } from "~/@/lib/typography";
import {
  firstNonEmpty,
  formatIndexLevel,
  formatIsoDate,
  formatSigned,
  indexLabel,
  pctVersus,
} from "~/@/lib/strategies/format";
import type { MarketRegimeView, RegimeLabel } from "~/@/lib/strategies/types";

/**
 * The market regime, read first (Zanger's rule 6).
 *
 * Props-only and server-safe. A downtrend renders in the warm alert register
 * (clay rust hairline and wash, text kept in the foreground ink for contrast),
 * never a red fill: red is quarantined for the direction of a number, and a
 * regime is a condition, not a price move. The verdict sentence is the
 * strategy's own (or the neutral one on the hub) and comes from the API.
 */

const REGIME_WORD: Record<Exclude<RegimeLabel, "">, string> = {
  uptrend: "Uptrend",
  neutral: "Neutral",
  downtrend: "Downtrend",
};

function RegimePill({ regime }: { regime: RegimeLabel }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.16em]",
        regime === "uptrend" && "border-primary/50 bg-primary/10 text-primary",
        regime === "neutral" && "border-input text-foreground",
        regime === "downtrend" && "border-accent/60 text-foreground",
        regime === "" && "border-border text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          regime === "uptrend" && "bg-primary",
          regime === "neutral" && "bg-muted-foreground",
          regime === "downtrend" && "bg-accent",
          regime === "" && "border border-dashed border-muted-foreground",
        )}
      />
      {regime ? REGIME_WORD[regime] : "Unavailable"}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export interface RegimeBannerProps {
  regime: MarketRegimeView | null;
  /** Accessible name for the region; defaults to "Market regime". */
  label?: string;
}

export function RegimeBanner({ regime, label = "Market regime" }: RegimeBannerProps) {
  const regimeLabel = regime?.regime ?? "";
  const asOf = formatIsoDate(regime?.asOf);
  const verdict = firstNonEmpty(
    regime?.verdict,
    "Market regime unavailable: the index trend cannot be read right now.",
  );

  return (
    <section
      aria-label={label}
      className={cn(
        "rounded-lg border p-4 sm:p-5",
        regimeLabel === "downtrend"
          ? "border-accent/50 bg-accent/5"
          : "border-border/60 bg-card",
      )}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className={eyebrow}>
            Market regime · {indexLabel(regime?.indexCode ?? "XJO")}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <RegimePill regime={regimeLabel} />
            {asOf ? (
              <span className="text-xs text-muted-foreground">
                as of{" "}
                <time dateTime={regime!.asOf} className="tabular-nums">
                  {asOf}
                </time>
              </span>
            ) : null}
          </div>
        </div>
        {regimeLabel ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 md:text-right">
            <Stat label="Close" value={formatIndexLevel(regime!.close)} />
            <Stat
              label="vs 50-day"
              value={formatSigned(pctVersus(regime!.close, regime!.sma50))}
            />
            <Stat
              label="vs 200-day"
              value={formatSigned(pctVersus(regime!.close, regime!.sma200))}
            />
            <Stat
              label="Off 52w high"
              value={formatSigned(regime!.pctOff52wHigh)}
            />
          </dl>
        ) : null}
      </div>
      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-foreground">
        {verdict}
      </p>
    </section>
  );
}
