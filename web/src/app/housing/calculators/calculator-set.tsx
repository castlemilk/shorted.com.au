import {
  DepositCalculator,
  MortgageSimulator,
  RentVsBuyCalculator,
  StampDutyCalculator,
} from "@/components/housing/calculators/calculators";

import { type CalculatorPrefill } from "./prefill";

/*
 * The parts of /housing/calculators that depend on the prefill. No hooks and
 * no directive: the server page renders them unprefilled as its Suspense
 * fallbacks (the markup the static HTML carries), and the client island
 * renders them again from the query.
 */

/** The four calculators, all started from one prefill. */
export function CalculatorSet({
  price,
  state,
  initialLoan,
}: Pick<CalculatorPrefill, "price" | "state" | "initialLoan">) {
  return (
    <>
      <MortgageSimulator initialLoan={initialLoan} />
      <DepositCalculator initialPrice={price} initialState={state} />
      <StampDutyCalculator initialPrice={price} initialState={state} />
      <RentVsBuyCalculator initialPrice={price} initialState={state} />
    </>
  );
}

/** The intro's last sentence: where the starting price came from. */
export function PrefillNote({ prefill }: { prefill: CalculatorPrefill }) {
  if (!prefill.prefilled) {
    return (
      <> Defaults start from the national mean dwelling price tracked on our{" "}
        <a href="/housing" className="text-foreground underline underline-offset-2 hover:text-primary">house-prices dashboard</a>.</>
    );
  }
  return (
    <> Prefilled with a median price of{" "}
      <span className="font-mono text-foreground">${prefill.price.toLocaleString("en-AU")}</span>
      {prefill.stateGiven ? <> in {prefill.state}</> : null} from the suburb you came from.</>
  );
}
