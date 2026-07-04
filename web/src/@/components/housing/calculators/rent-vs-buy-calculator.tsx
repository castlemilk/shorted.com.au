"use client";

import { useMemo, useState } from "react";
import { rentVsBuy } from "@/lib/housing/rent-vs-buy";
import {
  STAMP_DUTY_STATES,
  type StampDutyState,
} from "@/lib/housing/stamp-duty";
import { cn } from "@/lib/utils";
import {
  CalcCard,
  CalcDisclaimer,
  CalcStat,
  LabeledSlider,
  fmtAUD,
  fmtAUDShort,
} from "./calc-ui";
import { RentVsBuyChart } from "./rent-vs-buy-chart";

/**
 * Rent-vs-buy comparison card. Pure client-side maths (rent-vs-buy.ts) — no
 * RPCs. Loaded via calculators.tsx (dynamic, ssr:false) because the net-worth
 * chart measures on mount. All props are serializable.
 */
export function RentVsBuyCalculator({
  initialPrice = 1_000_000,
  initialState = "NSW",
}: {
  initialPrice?: number;
  initialState?: StampDutyState;
}) {
  const [price, setPrice] = useState(initialPrice);
  const [weeklyRent, setWeeklyRent] = useState(650);
  const [depositPct, setDepositPct] = useState(20);
  const [rate, setRate] = useState(6.0);
  const [horizon, setHorizon] = useState(10);

  // Advanced assumptions (behind the disclosure).
  const [state, setState] = useState<StampDutyState>(initialState);
  const [appreciation, setAppreciation] = useState(4.0);
  const [rentInflation, setRentInflation] = useState(3.0);
  const [investmentReturn, setInvestmentReturn] = useState(6.0);
  const [ownershipCost, setOwnershipCost] = useState(1.5);

  const result = useMemo(
    () =>
      rentVsBuy({
        price,
        depositPct,
        state,
        mortgageRatePct: rate,
        weeklyRent,
        horizonYears: horizon,
        appreciationPct: appreciation,
        rentInflationPct: rentInflation,
        investmentReturnPct: investmentReturn,
        ownershipCostPct: ownershipCost,
      }),
    [
      price,
      depositPct,
      state,
      rate,
      weeklyRent,
      horizon,
      appreciation,
      rentInflation,
      investmentReturn,
      ownershipCost,
    ],
  );

  const buyAhead = result.difference >= 0;
  const breakeven = result.breakevenYear;

  return (
    <CalcCard
      eyebrow="Interactive · rent vs buy"
      title="Rent vs buy"
      description="Buying builds equity but sinks cash into a deposit, stamp duty, interest and upkeep. Renting frees that money to invest. On an equal-budget basis, this projects each path's net worth over your horizon — and when (if) buying overtakes renting."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
        {/* inputs */}
        <div className="space-y-4">
          <LabeledSlider id="rvb-price" label="Property price" value={price} min={100_000} max={5_000_000} step={10_000} onChange={setPrice} />
          <LabeledSlider
            id="rvb-rent" label="Rent for the same home" value={weeklyRent} min={200} max={2_500} step={10}
            onChange={setWeeklyRent} format={fmtAUD} suffix="/wk"
          />
          <LabeledSlider
            id="rvb-deposit" label="Deposit" value={depositPct} min={5} max={60} step={1}
            onChange={setDepositPct} format={(v) => `${v}%`}
          />
          <LabeledSlider
            id="rvb-rate" label="Mortgage rate" value={rate} min={1} max={12} step={0.05}
            onChange={setRate} format={(v) => `${v.toFixed(2)}%`}
          />
          <LabeledSlider
            id="rvb-horizon" label="How long you'll stay" value={horizon} min={1} max={30} step={1}
            onChange={setHorizon} format={(v) => `${v} yrs`}
          />

          {/* Advanced assumptions */}
          <details className="group rounded-lg border border-border bg-background/40">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-mono text-[0.7rem] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground">
              <span>Assumptions</span>
              <span className="text-base leading-none transition-transform group-open:rotate-45">+</span>
            </summary>
            <div className="space-y-4 px-3 pb-4 pt-1">
              <div>
                <div className="mb-1.5 font-mono text-xs text-muted-foreground">Stamp-duty state</div>
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
              <LabeledSlider
                id="rvb-appreciation" label="Property growth" value={appreciation} min={0} max={10} step={0.5}
                onChange={setAppreciation} format={(v) => `${v.toFixed(1)}%`} suffix="/yr"
              />
              <LabeledSlider
                id="rvb-rentinf" label="Rent inflation" value={rentInflation} min={0} max={15} step={0.5}
                onChange={setRentInflation} format={(v) => `${v.toFixed(1)}%`} suffix="/yr"
              />
              <LabeledSlider
                id="rvb-invest" label="Investment return" value={investmentReturn} min={0} max={12} step={0.5}
                onChange={setInvestmentReturn} format={(v) => `${v.toFixed(1)}%`} suffix="/yr"
              />
              <LabeledSlider
                id="rvb-ownership" label="Ownership costs" value={ownershipCost} min={0} max={4} step={0.1}
                onChange={setOwnershipCost} format={(v) => `${v.toFixed(1)}%`} suffix="/yr"
              />
              <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
                The renter invests the deposit + {state} duty up front, then the
                monthly gap between owning and renting, at the investment return.
                Ownership costs cover rates, insurance and maintenance.
              </p>
            </div>
          </details>
        </div>

        {/* outputs */}
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <CalcStat
              big
              label={`Buying after ${horizon} yr${horizon === 1 ? "" : "s"}`}
              value={`${buyAhead ? "+" : "−"}${fmtAUDShort(Math.abs(result.difference))}`}
              sub={buyAhead ? "better off than renting" : "worse off than renting"}
              tone={buyAhead ? "good" : "bad"}
            />
            <CalcStat
              big
              label="Breakeven"
              value={breakeven != null ? `Year ${breakeven}` : "Renting wins"}
              sub={
                breakeven != null
                  ? "buying overtakes renting"
                  : `renting stays ahead over ${horizon} yr${horizon === 1 ? "" : "s"}`
              }
              tone={breakeven != null ? "good" : "bad"}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <CalcStat label="Buy net worth" value={fmtAUDShort(result.buyNetFinal)} sub={`equity at yr ${horizon}`} />
            <CalcStat label="Rent + invest net worth" value={fmtAUDShort(result.rentNetFinal)} sub={`portfolio at yr ${horizon}`} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <CalcStat label="Upfront to buy" value={fmtAUD(result.upfront)} sub={`${depositPct}% deposit + ${fmtAUDShort(result.stampDuty)} duty`} />
            <CalcStat label="Monthly mortgage" value={fmtAUD(result.monthlyMortgage)} sub={`vs ${fmtAUD(result.monthlyRent)} rent`} />
          </div>

          <RentVsBuyChart
            perYear={result.perYear}
            breakevenYear={result.breakevenYear}
          />
        </div>
      </div>
      <CalcDisclaimer>
        Highly assumption-sensitive — estimates only. Small changes to growth,
        rent inflation or investment return can flip the result; it ignores tax
        (negative gearing, CGT), selling costs and LMI.
      </CalcDisclaimer>
    </CalcCard>
  );
}
