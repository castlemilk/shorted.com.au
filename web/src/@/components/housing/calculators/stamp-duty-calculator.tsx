"use client";

import { useMemo, useState } from "react";
import { STATE_NAMES } from "@/lib/housing/states";
import {
  STAMP_DUTY_STATES,
  calculateStampDuty,
  stampDutyInfo,
  type StampDutyState,
} from "@/lib/housing/stamp-duty";
import { cn } from "@/lib/utils";
import { CalcCard, CalcDisclaimer, CalcStat, LabeledSlider, fmtAUD } from "./calc-ui";

/**
 * Stamp (transfer) duty estimator — baked 2025–26 owner-occupier general-rate
 * bracket tables per state (stamp-duty.ts). Concessions are noted, not
 * modelled.
 */
export function StampDutyCalculator({
  initialPrice = 1_000_000,
  initialState = "NSW",
}: {
  initialPrice?: number;
  initialState?: StampDutyState;
}) {
  const [state, setState] = useState<StampDutyState>(initialState);
  const [price, setPrice] = useState(initialPrice);

  const duty = useMemo(() => calculateStampDuty(state, price), [state, price]);
  const effectivePct = price > 0 ? (duty / price) * 100 : 0;
  const info = stampDutyInfo(state);

  return (
    <CalcCard
      eyebrow="Interactive · transfer duty"
      title="Stamp duty by state"
      description="Owner-occupier duty at general rates for the 2025–26 schedules. First-home-buyer and other concessions can substantially reduce this — they're flagged below, not calculated."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 font-mono text-xs text-muted-foreground">State / territory</div>
            <div className="grid grid-cols-4 gap-1.5">
              {STAMP_DUTY_STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={state === s}
                  onClick={() => setState(s)}
                  className={cn(
                    "rounded-md border px-2 py-1.5 font-mono text-[0.7rem] uppercase tracking-wider transition-colors",
                    state === s
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <LabeledSlider id="sd-price" label="Property price" value={price} min={100_000} max={5_000_000} step={10_000} onChange={setPrice} />
        </div>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <CalcStat big label={`${state} stamp duty`} value={fmtAUD(duty)} sub={STATE_NAMES[state]} />
            <CalcStat big label="Effective rate" value={`${effectivePct.toFixed(2)}%`} sub="duty as a share of the price" />
          </div>
          <p className="rounded-lg border border-border bg-background/60 p-3 text-[0.75rem] leading-relaxed text-muted-foreground">
            {info.concessionNote}{" "}
            <a
              href={info.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2 hover:text-primary"
            >
              Source
            </a>
          </p>
        </div>
      </div>
      <CalcDisclaimer />
    </CalcCard>
  );
}
