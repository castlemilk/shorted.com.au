/**
 * Pure mortgage / savings maths for the housing calculators
 * (`/housing/calculators`). No React, no I/O — unit-tested in
 * mortgage-math.test.ts (same convention as map-lod.ts).
 *
 * Model notes:
 * - Standard monthly amortisation: fixed payment derived from the full term.
 * - An offset balance reduces the interest-bearing principal each month
 *   (`max(0, balance - offset)`) while the payment is unchanged, so the
 *   schedule shortens.
 * - Extra monthly repayments and a one-off lump sum also shorten the
 *   schedule; the contracted payment never changes.
 */

export interface MortgageInputs {
  /** Loan principal in dollars. */
  principal: number;
  /** Nominal annual interest rate, percent (e.g. 6.0). */
  annualRatePct: number;
  /** Contracted loan term in years. */
  termYears: number;
  /** Voluntary extra repayment per month, dollars. */
  extraMonthly?: number;
  /** One-off lump-sum repayment, dollars. */
  lumpSum?: number;
  /** Year of the loan the lump sum is paid at the START of (1 = first year). */
  lumpSumYear?: number;
  /** Offset-account balance, dollars (assumed constant). */
  offsetBalance?: number;
}

export interface AmortisationResult {
  /** Contracted monthly repayment (excludes extras). */
  monthlyPayment: number;
  /** Months until the balance reaches zero. */
  months: number;
  /** Total interest paid over the life of the loan. */
  totalInterest: number;
  /** Remaining balance at the end of each month; index 0 = starting balance. */
  balances: number[];
}

/** Standard amortising monthly repayment for a principal/rate/term. */
export function monthlyPayment(
  principal: number,
  annualRatePct: number,
  termYears: number,
): number {
  const n = Math.round(termYears * 12);
  if (n <= 0 || principal <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

/**
 * Simulate the full month-by-month schedule. Deterministic and bounded:
 * because the payment is derived from the contracted term and extras only
 * ever reduce the balance, payoff can never exceed the contracted term
 * (a hard cap guards against degenerate float behaviour anyway).
 */
export function amortise(inputs: MortgageInputs): AmortisationResult {
  const {
    principal,
    annualRatePct,
    termYears,
    extraMonthly = 0,
    lumpSum = 0,
    lumpSumYear = 1,
    offsetBalance = 0,
  } = inputs;

  const n = Math.round(termYears * 12);
  const payment = monthlyPayment(principal, annualRatePct, termYears);
  if (payment <= 0) {
    return { monthlyPayment: 0, months: 0, totalInterest: 0, balances: [0] };
  }

  const r = annualRatePct / 100 / 12;
  const lumpMonth = Math.max(1, Math.round((lumpSumYear - 1) * 12) + 1);

  let balance = principal;
  let totalInterest = 0;
  const balances: number[] = [balance];
  let month = 0;
  const cap = n + 12; // safety guard; payoff mathematically ≤ n

  while (balance > 0.005 && month < cap) {
    month += 1;
    if (lumpSum > 0 && month === lumpMonth) {
      balance = Math.max(0, balance - lumpSum);
      if (balance <= 0.005) {
        balances.push(0);
        break;
      }
    }
    const interest = Math.max(0, balance - offsetBalance) * r;
    totalInterest += interest;
    balance = balance + interest - (payment + extraMonthly);
    if (balance < 0) balance = 0;
    balances.push(balance);
  }

  return { monthlyPayment: payment, months: month, totalInterest, balances };
}

/** Human-friendly "N yr M mo" splitter for a month count. */
export function splitMonths(months: number): { years: number; months: number } {
  return { years: Math.floor(months / 12), months: months % 12 };
}

export interface DepositInputs {
  /** Savings target in dollars (deposit, optionally + stamp duty). */
  target: number;
  /** Current savings, dollars. */
  currentSavings: number;
  /** Amount saved per month, dollars. */
  monthlySaving: number;
  /** Nominal annual savings interest rate, percent (monthly compounding). */
  annualRatePct: number;
}

/** Hard horizon after which we call the goal unreachable ("never"). */
export const DEPOSIT_NEVER_MONTHS = 1200; // 100 years

/**
 * Months of monthly-compounding saving until `target` is reached.
 * Returns 0 when already there, `null` when unreachable within
 * DEPOSIT_NEVER_MONTHS (e.g. saving $0 with the target above savings).
 */
export function monthsToDeposit(inputs: DepositInputs): number | null {
  const { target, currentSavings, monthlySaving, annualRatePct } = inputs;
  if (target <= 0 || currentSavings >= target) return 0;
  const r = annualRatePct / 100 / 12;
  let balance = currentSavings;
  for (let m = 1; m <= DEPOSIT_NEVER_MONTHS; m++) {
    balance = balance * (1 + r) + monthlySaving;
    if (balance >= target) return m;
  }
  return null;
}
