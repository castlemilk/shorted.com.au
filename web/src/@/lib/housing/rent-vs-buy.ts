/**
 * Pure rent-vs-buy comparison maths for the housing calculators
 * (`/housing/calculators`). No React, no I/O — unit-tested in
 * rent-vs-buy.test.ts (same convention as mortgage-math.test.ts).
 *
 * ── Consistent net-worth convention ────────────────────────────────────────
 * The only way a rent-vs-buy comparison is meaningful is if both households
 * start with the SAME cash and spend the SAME cash every month — otherwise
 * you're comparing two different budgets. So:
 *
 *   • Both start with `upfront = deposit + stamp duty` (the buyer's total
 *     cash-to-buy). The BUYER spends it — the deposit becomes home equity and
 *     the duty is a sunk transaction cost (gone). The RENTER, choosing not to
 *     buy, invests that same lump sum. This is why the renter begins exactly
 *     `stamp duty` ahead: buying starts you behind by your transaction costs.
 *
 *   • Each month both spend the SAME total `budget = max(buyOutlay, rent)`.
 *     The buyer spends `buyOutlay` (mortgage P&I + ownership costs) on housing;
 *     the renter spends `rent` on housing. Whoever spends less on housing that
 *     month invests the surplus (`budget − their housing cost`) into a
 *     portfolio compounding at the investment return. In the usual case the
 *     buyer's outlay is the larger, so the renter invests the difference
 *     (deposit+duty up front, then buyOutlay−rent each month) — but the model
 *     is symmetric, so once rent outgrows the buyer's outlay the BUYER starts
 *     investing the surplus instead. Either way the budgets stay equal.
 *
 * Net position on that shared basis is therefore:
 *   • BUY  = home equity (value − loan balance) + buyer's side portfolio
 *   • RENT = renter's portfolio (the invested up-front cash + monthly surpluses)
 * and `difference = buyNet − rentNet` is a like-for-like net-worth gap.
 *
 * Rate convention: annual rates are applied with nominal monthly compounding
 * (`annualPct / 100 / 12`), matching mortgage-math.ts and monthsToDeposit —
 * appreciation, rent inflation and the investment return all compound monthly.
 */

import { amortise } from "./mortgage-math";
import { calculateStampDuty, type StampDutyState } from "./stamp-duty";

/** Comparison horizon is capped at 30 years. */
export const RENT_VS_BUY_MAX_HORIZON = 30;
/** Fixed mortgage term the loan amortises over (not a user input). */
export const RENT_VS_BUY_LOAN_TERM_YEARS = 30;

export interface RentVsBuyInputs {
  /** Purchase price in dollars. */
  price: number;
  /** Deposit as a percent of price (e.g. 20). */
  depositPct: number;
  /** State/territory for the stamp-duty calculation. */
  state: StampDutyState;
  /** Nominal annual mortgage rate, percent (e.g. 6.0). */
  mortgageRatePct: number;
  /** Weekly rent for an equivalent home, dollars. */
  weeklyRent: number;
  /** Comparison horizon in years (clamped to 1..30). */
  horizonYears: number;
  /** Annual property appreciation, percent. Default 4. */
  appreciationPct?: number;
  /** Annual rent inflation, percent. Default 3. */
  rentInflationPct?: number;
  /** Annual investment return on the invested surplus, percent. Default 6. */
  investmentReturnPct?: number;
  /** Annual ownership costs (rates/insurance/maintenance) as % of current value. Default 1.5. */
  ownershipCostPct?: number;
  /** Loan term in years the mortgage amortises over. Default 30. */
  loanTermYears?: number;
}

/** Net position of each path at a year boundary (year 0 = purchase time). */
export interface RentVsBuyYearPoint {
  year: number;
  /** Buy-path net worth: home equity + buyer's side portfolio. */
  buyNet: number;
  /** Rent-path net worth: invested portfolio value. */
  rentNet: number;
}

export interface RentVsBuyResult {
  /** Net position per year, index 0 = purchase time through the horizon inclusive. */
  perYear: RentVsBuyYearPoint[];
  /** Buy-path net worth at the horizon. */
  buyNetFinal: number;
  /** Rent-path net worth at the horizon. */
  rentNetFinal: number;
  /** buyNetFinal − rentNetFinal (positive ⇒ buying is ahead). */
  difference: number;
  /** First year (≥1) at which the buy path catches or overtakes renting; null if never within the horizon. */
  breakevenYear: number | null;
  /** Up-front cash both paths start with (deposit + stamp duty). */
  upfront: number;
  /** Deposit amount (price × depositPct). */
  deposit: number;
  /** Estimated stamp duty for the state/price. */
  stampDuty: number;
  /** Contracted monthly mortgage repayment (P&I). */
  monthlyMortgage: number;
  /** Starting monthly rent (weekly × 52 / 12). */
  monthlyRent: number;
}

/** Nominal monthly rate for an annual percent (monthly compounding). */
function monthlyRate(annualPct: number): number {
  return annualPct / 100 / 12;
}

/**
 * Compare buying vs renting over a horizon on a consistent net-worth basis
 * (see the module comment). Deterministic and finite for all inputs.
 */
export function rentVsBuy(inputs: RentVsBuyInputs): RentVsBuyResult {
  const {
    price,
    depositPct,
    state,
    mortgageRatePct,
    weeklyRent,
    horizonYears,
    appreciationPct = 4,
    rentInflationPct = 3,
    investmentReturnPct = 6,
    ownershipCostPct = 1.5,
    loanTermYears = RENT_VS_BUY_LOAN_TERM_YEARS,
  } = inputs;

  const horizon = Math.max(
    1,
    Math.min(RENT_VS_BUY_MAX_HORIZON, Math.round(horizonYears)),
  );
  const deposit = Math.max(0, (price * depositPct) / 100);
  const loan = Math.max(0, price - deposit);
  const stampDuty = calculateStampDuty(state, price);
  const upfront = deposit + stampDuty;

  // Reuse the amortisation schedule: `balances[m]` is the loan balance after m
  // months (index 0 = starting balance). Cash paid in month m is derived from
  // the balance drop + interest so the tail month isn't over-counted.
  const schedule = amortise({
    principal: loan,
    annualRatePct: mortgageRatePct,
    termYears: loanTermYears,
  });
  const balances = schedule.balances;
  const rMortgage = monthlyRate(mortgageRatePct);

  const gAppreciation = monthlyRate(appreciationPct);
  const gRent = monthlyRate(rentInflationPct);
  const rInvest = monthlyRate(investmentReturnPct);
  const ownershipMonthlyRate = ownershipCostPct / 100 / 12;

  let homeValue = price;
  let monthlyRentNow = (weeklyRent * 52) / 12;
  const startingMonthlyRent = monthlyRentNow;

  let renterPortfolio = upfront; // renter invests the buyer's up-front cash
  let buyerPortfolio = 0; // buyer only invests once rent outgrows their outlay

  const balanceAt = (m: number) => (m < balances.length ? balances[m]! : 0);

  const netPoint = (year: number): RentVsBuyYearPoint => ({
    year,
    buyNet: homeValue - balanceAt(year * 12) + buyerPortfolio,
    rentNet: renterPortfolio,
  });

  const perYear: RentVsBuyYearPoint[] = [netPoint(0)];
  const totalMonths = horizon * 12;

  for (let m = 1; m <= totalMonths; m++) {
    // BUY outlay: mortgage cash this month (from the schedule) + ownership costs.
    const startBal = balanceAt(m - 1);
    const endBal = balanceAt(m);
    const interest = startBal * rMortgage;
    const mortgageThisMonth =
      startBal > 0 ? Math.max(0, startBal + interest - endBal) : 0;
    const ownershipThisMonth = homeValue * ownershipMonthlyRate;
    const buyOutlay = mortgageThisMonth + ownershipThisMonth;

    // RENT outlay this month.
    const rentThisMonth = monthlyRentNow;

    // Shared budget: both spend the larger of the two, invest their surplus.
    const budget = Math.max(buyOutlay, rentThisMonth);
    const buyerContribution = budget - buyOutlay; // ≥ 0
    const renterContribution = budget - rentThisMonth; // ≥ 0

    buyerPortfolio = buyerPortfolio * (1 + rInvest) + buyerContribution;
    renterPortfolio = renterPortfolio * (1 + rInvest) + renterContribution;

    // Grow the home value and next month's rent.
    homeValue = homeValue * (1 + gAppreciation);
    monthlyRentNow = monthlyRentNow * (1 + gRent);

    if (m % 12 === 0) perYear.push(netPoint(m / 12));
  }

  const final = perYear[perYear.length - 1]!;
  const buyNetFinal = final.buyNet;
  const rentNetFinal = final.rentNet;

  let breakevenYear: number | null = null;
  for (const point of perYear) {
    if (point.year >= 1 && point.buyNet >= point.rentNet) {
      breakevenYear = point.year;
      break;
    }
  }

  return {
    perYear,
    buyNetFinal,
    rentNetFinal,
    difference: buyNetFinal - rentNetFinal,
    breakevenYear,
    upfront,
    deposit,
    stampDuty,
    monthlyMortgage: schedule.monthlyPayment,
    monthlyRent: startingMonthlyRent,
  };
}
