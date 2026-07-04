"use client";

import { useMemo, useState } from "react";
import { SegmentedToggle } from "@/components/features/housing/charts/chart-ui";
import { monthsToDeposit, splitMonths } from "@/lib/housing/mortgage-math";
import { calculateStampDuty, type StampDutyState } from "@/lib/housing/stamp-duty";
import { CalcCard, CalcDisclaimer, CalcStat, LabeledSlider, fmtAUD, fmtAUDShort } from "./calc-ui";

const DEPOSIT_PCTS = ["5", "10", "15", "20"] as const;
type DepositPct = (typeof DEPOSIT_PCTS)[number];

/**
 * Years-to-deposit calculator: monthly-compounding savings towards a deposit
 * target, optionally including the state's stamp duty (from stamp-duty.ts).
 */
export function DepositCalculator({
  initialPrice = 1_000_000,
  initialState = "NSW",
}: {
  initialPrice?: number;
  initialState?: StampDutyState;
}) {
  const [price, setPrice] = useState(initialPrice);
  const [depositPct, setDepositPct] = useState<DepositPct>("20");
  const [currentSavings, setCurrentSavings] = useState(50_000);
  const [monthlySaving, setMonthlySaving] = useState(2_000);
  const [savingsRate, setSavingsRate] = useState(4.5);
  const [includeDuty, setIncludeDuty] = useState(false);

  const deposit = (price * Number(depositPct)) / 100;
  const duty = useMemo(
    () => (includeDuty ? calculateStampDuty(initialState, price) : 0),
    [includeDuty, initialState, price],
  );
  const target = deposit + duty;

  const months = useMemo(
    () =>
      monthsToDeposit({
        target,
        currentSavings,
        monthlySaving,
        annualRatePct: savingsRate,
      }),
    [target, currentSavings, monthlySaving, savingsRate],
  );

  let when: string;
  let sub: string;
  if (months === null) {
    when = "Never";
    sub = "at this saving rate the target is out of reach";
  } else if (months === 0) {
    when = "Now";
    sub = "your savings already cover the target";
  } else {
    const { years, months: rem } = splitMonths(months);
    when = years > 0 ? `${years} yr${rem ? ` ${rem} mo` : ""}` : `${rem} mo`;
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    sub = `around ${d.toLocaleDateString("en-AU", { month: "long", year: "numeric" })}`;
  }

  return (
    <CalcCard
      eyebrow="Interactive · saving"
      title="Years to a deposit"
      description="How long until your savings reach the deposit, with interest compounding monthly. Optionally fold the state's stamp duty into the target."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
        <div className="space-y-4">
          <LabeledSlider id="dc-price" label="Property price" value={price} min={100_000} max={5_000_000} step={10_000} onChange={setPrice} />
          <div>
            <div className="mb-1.5 font-mono text-xs text-muted-foreground">Deposit</div>
            <SegmentedToggle<DepositPct>
              ariaLabel="Deposit percentage"
              value={depositPct}
              onChange={setDepositPct}
              options={DEPOSIT_PCTS.map((p) => ({ value: p, label: `${p}%` }))}
            />
          </div>
          <LabeledSlider id="dc-savings" label="Current savings" value={currentSavings} min={0} max={1_000_000} step={5_000} onChange={setCurrentSavings} />
          <LabeledSlider id="dc-monthly" label="Saving / month" value={monthlySaving} min={0} max={20_000} step={100} onChange={setMonthlySaving} format={fmtAUD} />
          <LabeledSlider
            id="dc-rate" label="Savings interest rate" value={savingsRate} min={0} max={8} step={0.1}
            onChange={setSavingsRate} format={(v) => `${v.toFixed(1)}%`}
          />
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeDuty}
              onChange={(e) => setIncludeDuty(e.target.checked)}
              className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
            />
            Include {initialState} stamp duty in the target
          </label>
        </div>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <CalcStat big label="Time to deposit" value={when} sub={sub} tone={months === null ? "bad" : undefined} />
            <CalcStat big label="Savings target" value={fmtAUDShort(target)} sub={`${depositPct}% deposit${includeDuty ? ` + ${fmtAUDShort(duty)} duty` : ""}`} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <CalcStat label="Deposit required" value={fmtAUD(deposit)} sub={`${depositPct}% of ${fmtAUDShort(price)}`} />
            <CalcStat label="Still to save" value={fmtAUD(Math.max(0, target - currentSavings))} sub="before interest earned" />
          </div>
          {Number(depositPct) < 20 ? (
            <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
              Below a 20% deposit most lenders charge Lenders Mortgage
              Insurance (not modelled here) unless you use a guarantor or a
              government scheme.
            </p>
          ) : null}
        </div>
      </div>
      <CalcDisclaimer />
    </CalcCard>
  );
}
