"use client";

import { useMemo, useState } from "react";
import { amortise, splitMonths } from "@/lib/housing/mortgage-math";
import { BalanceChart } from "./balance-chart";
import { CalcCard, CalcDisclaimer, CalcStat, LabeledSlider, fmtAUD, fmtAUDShort } from "./calc-ui";

const RATE_SHOCKS = [1, 2, 3] as const;

function fmtDuration(months: number): string {
  const { years, months: rem } = splitMonths(months);
  if (years === 0) return `${rem} mo`;
  if (rem === 0) return `${years} yr`;
  return `${years} yr ${rem} mo`;
}

function payoffDate(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString("en-AU", { month: "short", year: "numeric" });
}

/**
 * Interactive mortgage / repayment simulator. Pure client-side maths
 * (mortgage-math.ts) — no RPCs. Loaded via calculators.tsx (dynamic,
 * ssr:false) because the balance chart measures on mount.
 */
export function MortgageSimulator({ initialLoan = 750_000 }: { initialLoan?: number }) {
  const [loan, setLoan] = useState(initialLoan);
  const [rate, setRate] = useState(6.0);
  const [termYears, setTermYears] = useState(30);
  const [extraMonthly, setExtraMonthly] = useState(0);
  const [lumpSum, setLumpSum] = useState(0);
  const [lumpSumYear, setLumpSumYear] = useState(5);
  const [offset, setOffset] = useState(0);

  const hasExtras = extraMonthly > 0 || lumpSum > 0 || offset > 0;

  const baseline = useMemo(
    () => amortise({ principal: loan, annualRatePct: rate, termYears }),
    [loan, rate, termYears],
  );
  const scenario = useMemo(
    () =>
      hasExtras
        ? amortise({
            principal: loan,
            annualRatePct: rate,
            termYears,
            extraMonthly,
            lumpSum,
            lumpSumYear,
            offsetBalance: offset,
          })
        : null,
    [hasExtras, loan, rate, termYears, extraMonthly, lumpSum, lumpSumYear, offset],
  );

  const active = scenario ?? baseline;
  const interestSaved = scenario ? baseline.totalInterest - scenario.totalInterest : 0;
  const monthsCut = scenario ? baseline.months - scenario.months : 0;

  const shocks = useMemo(
    () =>
      RATE_SHOCKS.map((pp) => ({
        pp,
        payment: amortise({ principal: loan, annualRatePct: rate + pp, termYears }).monthlyPayment,
      })),
    [loan, rate, termYears],
  );

  return (
    <CalcCard
      eyebrow="Interactive · repayments"
      title="Mortgage simulator"
      description="Standard monthly amortisation. Extra repayments and a one-off lump sum shorten the schedule; an offset balance reduces the interest-bearing principal each month while your repayment stays the same."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
        {/* inputs */}
        <div className="space-y-4">
          <LabeledSlider id="ms-loan" label="Loan amount" value={loan} min={50_000} max={3_000_000} step={10_000} onChange={setLoan} />
          <LabeledSlider
            id="ms-rate" label="Interest rate" value={rate} min={1} max={12} step={0.05}
            onChange={setRate} format={(v) => `${v.toFixed(2)}%`}
          />
          <LabeledSlider
            id="ms-term" label="Loan term" value={termYears} min={10} max={35} step={1}
            onChange={setTermYears} format={(v) => `${v} yrs`}
          />
          <LabeledSlider id="ms-extra" label="Extra repayment / month" value={extraMonthly} min={0} max={5_000} step={50} onChange={setExtraMonthly} format={fmtAUD} />
          <LabeledSlider id="ms-lump" label="One-off lump sum" value={lumpSum} min={0} max={500_000} step={5_000} onChange={setLumpSum} />
          {lumpSum > 0 ? (
            <LabeledSlider
              id="ms-lump-year" label="Lump sum paid in year" value={lumpSumYear} min={1} max={termYears} step={1}
              onChange={setLumpSumYear} format={(v) => `yr ${v}`}
            />
          ) : null}
          <LabeledSlider id="ms-offset" label="Offset balance" value={offset} min={0} max={500_000} step={5_000} onChange={setOffset} />
        </div>

        {/* outputs */}
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <CalcStat big label="Monthly repayment" value={fmtAUD(baseline.monthlyPayment + extraMonthly)} sub={extraMonthly > 0 ? `${fmtAUD(baseline.monthlyPayment)} + ${fmtAUD(extraMonthly)} extra` : "principal + interest"} />
            <CalcStat big label="Total interest" value={fmtAUDShort(active.totalInterest)} sub={`over ${fmtDuration(active.months)}`} />
            <CalcStat big label="Paid off" value={payoffDate(active.months)} sub={hasExtras ? `vs ${payoffDate(baseline.months)} baseline` : `${termYears}-year schedule`} />
          </div>

          {hasExtras ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <CalcStat label="Interest saved vs baseline" value={fmtAUDShort(Math.max(0, interestSaved))} tone="good" />
              <CalcStat label="Time cut from the loan" value={monthsCut > 0 ? fmtDuration(monthsCut) : "—"} tone={monthsCut > 0 ? "good" : undefined} />
            </div>
          ) : null}

          <BalanceChart
            baseline={baseline.balances}
            withExtras={scenario?.balances ?? baseline.balances}
            hasExtras={hasExtras}
          />

          {/* rate-shock strip */}
          <div>
            <div className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
              If rates rise, your monthly repayment becomes
            </div>
            <div className="mt-2 grid grid-cols-3 gap-3">
              {shocks.map((s) => (
                <div
                  key={s.pp}
                  className="rounded-lg border p-3"
                  style={{
                    borderColor: "color-mix(in srgb, var(--semantic-red) 30%, transparent)",
                    backgroundColor: "color-mix(in srgb, var(--semantic-red) 6%, transparent)",
                  }}
                >
                  <div className="font-mono text-[0.7rem] font-semibold text-[color:var(--semantic-red)]">
                    +{s.pp}% → {(rate + s.pp).toFixed(2)}%
                  </div>
                  <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                    {fmtAUD(s.payment)}
                  </div>
                  <div className="text-[0.7rem] text-muted-foreground">
                    +{fmtAUD(s.payment - baseline.monthlyPayment)}/mo
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <CalcDisclaimer>
        Assumes a constant rate and a constant offset balance; real loans
        reprice and compound slightly differently by lender.
      </CalcDisclaimer>
    </CalcCard>
  );
}
