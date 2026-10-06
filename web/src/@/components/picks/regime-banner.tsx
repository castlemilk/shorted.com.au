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
 * The market regime, read first (Zanger's rule 6): the one gauge on the desk.
 *
 * Props-only and server-safe. The pill names the regime, four recessed
 * readouts carry the numbers (the accessible, crawlable truth, each exactly
 * once), and under them a LADDER draws the same four facts as rungs on a
 * track: the 200-day average at the centre, the 50-day beside it, the
 * 52-week high as a dashed rung, and the close as the needle. The ladder is
 * aria-hidden and holds no text, so it can never duplicate a readout.
 *
 * A downtrend renders in the warm alert register (clay rust hairline, wash
 * and needle; text stays in the foreground ink for contrast), never a red
 * fill: red is quarantined for the direction of a number, and a regime is a
 * condition, not a price move. The verdict sentence is the strategy's own
 * (or the neutral one on the hub) and comes from the API.
 */

const REGIME_WORD: Record<Exclude<RegimeLabel, "">, string> = {
  uptrend: "Uptrend",
  neutral: "Neutral",
  downtrend: "Downtrend",
};

/** Lamps are square so they are never mistaken for the round rule dots. */
function RegimeLamp({ regime }: { regime: RegimeLabel }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-[1px]",
        regime === "uptrend" && "bg-primary",
        regime === "neutral" && "bg-muted-foreground",
        regime === "downtrend" && "bg-accent",
        regime === "" && "border border-dashed border-muted-foreground",
      )}
    />
  );
}

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
      <RegimeLamp regime={regime} />
      {regime ? REGIME_WORD[regime] : "Unavailable"}
    </span>
  );
}

/** The needle's colour: amber lit, ink at rest, clay rust as the alert. */
function needleTone(regime: RegimeLabel): string {
  if (regime === "uptrend") return "bg-primary";
  if (regime === "downtrend") return "bg-accent";
  return "bg-foreground";
}

/** How far either side of the 200-day average the ladder shows. */
export const LADDER_DOMAIN_PCT = 12;

/** A level's position on the ladder, 0 to 100, clamped to the domain. */
export function ladderX(pctVs200: number | null): number | null {
  if (pctVs200 === null || !Number.isFinite(pctVs200)) return null;
  const clamped = Math.max(-LADDER_DOMAIN_PCT, Math.min(LADDER_DOMAIN_PCT, pctVs200));
  return 50 + (clamped * 50) / LADDER_DOMAIN_PCT;
}

export interface LadderMarks {
  /** The close. Null when the close or the 200-day is unknown. */
  needle: number | null;
  sma50: number | null;
  /** The 52-week high, reconstructed from the close and its distance off it. */
  high: number | null;
}

/** The rungs, as positions on the track; the 200-day rung is always 50. */
export function ladderMarks(regime: MarketRegimeView): LadderMarks {
  const { close, sma50, sma200, pctOff52wHigh } = regime;
  const high =
    close !== null && pctOff52wHigh !== null && pctOff52wHigh > -100
      ? close / (1 + pctOff52wHigh / 100)
      : null;
  return {
    needle: ladderX(pctVersus(close, sma200)),
    sma50: ladderX(pctVersus(sma50, sma200)),
    high: ladderX(pctVersus(high, sma200)),
  };
}

/**
 * The gauge face. No text, aria-hidden: the readouts above it are its
 * legend (each label carries a swatch of its rung's shape). The needle is
 * positioned with `left` and animated with transform only, so settling it
 * never moves layout; the resting position is also the animation's final
 * frame, which is what a reduced-motion reader gets from the first paint.
 */
function RegimeLadder({ regime }: { regime: MarketRegimeView }) {
  const marks = ladderMarks(regime);
  if (marks.needle === null) return null;
  return (
    <div aria-hidden="true" className="relative mt-4 h-8 select-none">
      <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <span
        data-ladder-mark="sma200"
        className="absolute top-1.5 h-5 w-px bg-foreground/70"
        style={{ left: "50%" }}
      />
      {marks.sma50 !== null ? (
        <span
          data-ladder-mark="sma50"
          className="absolute top-2.5 h-3 w-px bg-foreground/70"
          style={{ left: `${marks.sma50}%` }}
        />
      ) : null}
      {marks.high !== null ? (
        <span
          data-ladder-mark="high"
          className="absolute top-1.5 h-5 w-0 border-l border-dashed border-muted-foreground"
          style={{ left: `${marks.high}%` }}
        />
      ) : null}
      <span
        data-ladder-mark="close"
        className={cn(
          "absolute top-0 h-8 w-0.5 motion-safe:animate-needle-settle motion-safe:[animation-delay:120ms]",
          needleTone(regime.regime),
        )}
        style={{ left: `calc(${marks.needle}% - 1px)` }}
      />
    </div>
  );
}

/**
 * A recessed readout window. Numbers are first-class and sit still: the
 * only things that move on the gauge are the warm-up and the needle.
 */
function Readout({
  label,
  value,
  swatch,
}: {
  label: string;
  value: string;
  /** The rung this readout is the legend for. */
  swatch: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-sm border border-border/60 bg-background px-3 py-2 md:text-right">
      <dt className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground md:justify-end">
        {swatch}
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
  const tone = needleTone(regimeLabel);

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
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Readout
              label="Close"
              value={formatIndexLevel(regime!.close)}
              swatch={
                <span aria-hidden="true" className={cn("inline-block h-2.5 w-0.5", tone)} />
              }
            />
            <Readout
              label="vs 50-day"
              value={formatSigned(pctVersus(regime!.close, regime!.sma50))}
              swatch={
                <span aria-hidden="true" className="inline-block h-1.5 w-px bg-foreground/70" />
              }
            />
            <Readout
              label="vs 200-day"
              value={formatSigned(pctVersus(regime!.close, regime!.sma200))}
              swatch={
                <span aria-hidden="true" className="inline-block h-2.5 w-px bg-foreground/70" />
              }
            />
            <Readout
              label="Off 52w high"
              value={formatSigned(regime!.pctOff52wHigh)}
              swatch={
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-0 border-l border-dashed border-muted-foreground"
                />
              }
            />
          </dl>
        ) : null}
      </div>
      {regimeLabel && regime ? <RegimeLadder regime={regime} /> : null}
      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-foreground">
        {verdict}
      </p>
    </section>
  );
}
