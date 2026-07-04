import { describe, it, expect } from "@jest/globals";
import {
  amortise,
  monthlyPayment,
  monthsToDeposit,
  splitMonths,
} from "./mortgage-math";

describe("monthlyPayment", () => {
  it("is principal / months at zero rate", () => {
    expect(monthlyPayment(360_000, 0, 30)).toBeCloseTo(1000, 6);
  });
  it("matches the standard annuity formula", () => {
    // 750k @ 6% over 30y — well-known result ≈ $4,496.63/mo.
    expect(monthlyPayment(750_000, 6, 30)).toBeCloseTo(4496.63, 1);
  });
  it("is zero for degenerate inputs", () => {
    expect(monthlyPayment(0, 6, 30)).toBe(0);
    expect(monthlyPayment(500_000, 6, 0)).toBe(0);
  });
});

describe("amortise", () => {
  it("pays zero interest and runs the full term at zero rate", () => {
    const res = amortise({ principal: 360_000, annualRatePct: 0, termYears: 30 });
    expect(res.monthlyPayment).toBeCloseTo(1000, 6);
    expect(res.months).toBe(360);
    expect(res.totalInterest).toBeCloseTo(0, 6);
    expect(res.balances[0]).toBe(360_000);
    expect(res.balances[res.balances.length - 1]).toBe(0);
  });

  it("runs to (about) the contracted term with no extras", () => {
    const res = amortise({ principal: 750_000, annualRatePct: 6, termYears: 30 });
    // Float rounding can land a month early, never late.
    expect(res.months).toBeGreaterThanOrEqual(359);
    expect(res.months).toBeLessThanOrEqual(360);
    expect(res.totalInterest).toBeGreaterThan(850_000); // ≈ $868.8k
  });

  it("extra repayments shorten the term and save interest", () => {
    const base = amortise({ principal: 750_000, annualRatePct: 6, termYears: 30 });
    const extra = amortise({
      principal: 750_000,
      annualRatePct: 6,
      termYears: 30,
      extraMonthly: 500,
    });
    expect(extra.months).toBeLessThan(base.months);
    expect(extra.totalInterest).toBeLessThan(base.totalInterest);
    // Contracted payment is unchanged by extras.
    expect(extra.monthlyPayment).toBeCloseTo(base.monthlyPayment, 6);
  });

  it("charges no interest when the offset covers the whole principal", () => {
    const res = amortise({
      principal: 400_000,
      annualRatePct: 6,
      termYears: 30,
      offsetBalance: 400_000,
    });
    expect(res.totalInterest).toBeCloseTo(0, 6);
    // With zero interest the balance falls by a full payment per month.
    expect(res.months).toBe(Math.ceil(400_000 / res.monthlyPayment));
  });

  it("an offset larger than the principal behaves the same as a full offset", () => {
    const full = amortise({
      principal: 400_000, annualRatePct: 6, termYears: 30, offsetBalance: 400_000,
    });
    const over = amortise({
      principal: 400_000, annualRatePct: 6, termYears: 30, offsetBalance: 900_000,
    });
    expect(over.months).toBe(full.months);
    expect(over.totalInterest).toBeCloseTo(full.totalInterest, 6);
  });

  it("ignores a lump sum scheduled after payoff", () => {
    const base = amortise({ principal: 100_000, annualRatePct: 6, termYears: 10 });
    const late = amortise({
      principal: 100_000,
      annualRatePct: 6,
      termYears: 10,
      lumpSum: 50_000,
      lumpSumYear: 20, // loan is long gone by year 20
    });
    expect(late.months).toBe(base.months);
    expect(late.totalInterest).toBeCloseTo(base.totalInterest, 6);
  });

  it("a lump sum in year 1 shortens the schedule", () => {
    const base = amortise({ principal: 750_000, annualRatePct: 6, termYears: 30 });
    const lump = amortise({
      principal: 750_000,
      annualRatePct: 6,
      termYears: 30,
      lumpSum: 100_000,
      lumpSumYear: 1,
    });
    expect(lump.months).toBeLessThan(base.months);
    expect(lump.totalInterest).toBeLessThan(base.totalInterest);
  });
});

describe("splitMonths", () => {
  it("splits into years and remainder months", () => {
    expect(splitMonths(0)).toEqual({ years: 0, months: 0 });
    expect(splitMonths(13)).toEqual({ years: 1, months: 1 });
    expect(splitMonths(360)).toEqual({ years: 30, months: 0 });
  });
});

describe("monthsToDeposit", () => {
  it("is 0 when already at the target", () => {
    expect(
      monthsToDeposit({ target: 100_000, currentSavings: 120_000, monthlySaving: 0, annualRatePct: 4.5 }),
    ).toBe(0);
  });

  it("is null (never) when saving nothing below the target", () => {
    expect(
      monthsToDeposit({ target: 100_000, currentSavings: 10_000, monthlySaving: 0, annualRatePct: 0 }),
    ).toBeNull();
  });

  it("is exact without interest", () => {
    // 90k gap / 1.5k per month = 60 months.
    expect(
      monthsToDeposit({ target: 100_000, currentSavings: 10_000, monthlySaving: 1500, annualRatePct: 0 }),
    ).toBe(60);
  });

  it("compounding shortens the wait", () => {
    const flat = monthsToDeposit({
      target: 200_000, currentSavings: 20_000, monthlySaving: 2000, annualRatePct: 0,
    });
    const earning = monthsToDeposit({
      target: 200_000, currentSavings: 20_000, monthlySaving: 2000, annualRatePct: 4.5,
    });
    expect(flat).not.toBeNull();
    expect(earning).not.toBeNull();
    expect(earning!).toBeLessThan(flat!);
  });

  it("interest alone can eventually reach the target (not never)", () => {
    const m = monthsToDeposit({
      target: 30_000, currentSavings: 20_000, monthlySaving: 0, annualRatePct: 4.5,
    });
    expect(m).not.toBeNull();
    expect(m!).toBeGreaterThan(100); // ~9 years of pure compounding
  });
});
