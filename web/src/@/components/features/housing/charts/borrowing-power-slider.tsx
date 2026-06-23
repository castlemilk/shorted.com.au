"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { RATE_ELASTICITY } from "../data/series";
import { Cite } from "../cite";
import { SegmentedToggle } from "./chart-ui";

type Mode = "aggressive" | "conservative";

const BAR_MAX = 200; // index ceiling for the bar scale

/**
 * Illustrative borrowing-power calculator. The RBA's housing model (RDP
 * 2019-01) implies a sustained 1pp fall in the real mortgage rate lifts real
 * prices ~28% long-run (17% on a more conservative user-cost). Drag the rate to
 * see the implied price level, baseline (current rate) = 100. Holds incomes and
 * everything else constant — a teaching tool, not a forecast.
 */
export function BorrowingPowerSlider() {
  const { baselineRate, minRate, maxRate, aggressive, conservative } = RATE_ELASTICITY;
  const [rate, setRate] = useState<number>(baselineRate);
  const [mode, setMode] = useState<Mode>("aggressive");

  const elasticity = mode === "aggressive" ? aggressive : conservative;
  const changePct = elasticity * (baselineRate - rate);
  const level = 100 * (1 + changePct / 100);
  const up = changePct >= 0;
  const toneVar = up ? "var(--semantic-green)" : "var(--semantic-red)";

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-amber-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-primary">
            Interactive &middot; borrowing power
          </div>
          <h3 className="mt-1 font-serif text-xl text-foreground sm:text-2xl">
            What a rate move does to prices
          </h3>
        </div>
        <SegmentedToggle<Mode>
          ariaLabel="Elasticity assumption"
          value={mode}
          onChange={setMode}
          options={[
            { value: "aggressive", label: "28%/pp" },
            { value: "conservative", label: "17%/pp" },
          ]}
        />
      </div>

      <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted-foreground">
        The RBA&rsquo;s model implies a sustained 1&nbsp;percentage-point fall in
        the real mortgage rate raises real prices ~{elasticity}%, long-run, with
        incomes unchanged.<Cite id="rba-rdp-2019-01" /> Drag the rate &mdash; the
        current rate is the baseline (100).
      </p>

      {/* slider */}
      <div className="mt-6">
        <div className="flex items-baseline justify-between font-mono text-sm">
          <label htmlFor="rate-slider" className="text-muted-foreground">
            Real mortgage rate
          </label>
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {rate.toFixed(1)}%
          </span>
        </div>
        <input
          id="rate-slider"
          type="range"
          min={minRate}
          max={maxRate}
          step={0.1}
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-muted"
          style={{ accentColor: "hsl(var(--primary))" }}
        />
        <div className="mt-1 flex justify-between font-mono text-[0.65rem] text-muted-foreground">
          <span>{minRate.toFixed(1)}% — cheap money</span>
          <span>baseline {baselineRate.toFixed(1)}%</span>
          <span>{maxRate.toFixed(1)}% — tight</span>
        </div>
      </div>

      {/* result */}
      <div className="mt-7 grid gap-5 sm:grid-cols-[auto,1fr] sm:items-center">
        <div>
          <div className="font-mono text-5xl font-semibold tabular-nums" style={{ color: toneVar }}>
            {level.toFixed(0)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            implied real price index
          </div>
          <div
            className={cn("mt-1 font-mono text-sm font-semibold tabular-nums")}
            style={{ color: toneVar }}
          >
            {up ? "+" : ""}
            {changePct.toFixed(0)}% vs baseline
          </div>
        </div>

        {/* bars */}
        <div className="space-y-2">
          <BarRow label="Baseline" value={100} color="hsl(var(--muted-foreground))" />
          <BarRow label="Implied" value={level} color={toneVar} />
        </div>
      </div>
    </div>
  );
}

function BarRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const pct = Math.max(2, Math.min(100, (value / BAR_MAX) * 100));
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 font-mono text-[0.7rem] text-muted-foreground">{label}</span>
      <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
        <div
          className="h-full rounded transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-[0.7rem] tabular-nums text-muted-foreground">
        {value.toFixed(0)}
      </span>
    </div>
  );
}
