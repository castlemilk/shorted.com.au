import { describe, it, expect } from "@jest/globals";
import {
  rentVsBuy,
  RENT_VS_BUY_MAX_HORIZON,
  type RentVsBuyInputs,
} from "./rent-vs-buy";

/** A middle-of-the-road buyer used as the base for scenario tweaks. */
const BASE: RentVsBuyInputs = {
  price: 800_000,
  depositPct: 20,
  state: "NSW",
  mortgageRatePct: 6,
  weeklyRent: 600,
  horizonYears: 10,
};

const allFinite = (nums: number[]) => nums.every((n) => Number.isFinite(n));

describe("rentVsBuy — structure", () => {
  it("emits one point per year from 0 through the horizon inclusive", () => {
    const res = rentVsBuy({ ...BASE, horizonYears: 10 });
    expect(res.perYear).toHaveLength(11); // years 0..10
    expect(res.perYear[0]!.year).toBe(0);
    expect(res.perYear[res.perYear.length - 1]!.year).toBe(10);
    expect(res.buyNetFinal).toBe(res.perYear[10]!.buyNet);
    expect(res.rentNetFinal).toBe(res.perYear[10]!.rentNet);
    expect(res.difference).toBeCloseTo(res.buyNetFinal - res.rentNetFinal, 6);
  });

  it("starts both paths from deposit + duty (renter ahead by exactly the duty)", () => {
    const res = rentVsBuy(BASE);
    expect(res.deposit).toBeCloseTo(160_000, 6);
    expect(res.stampDuty).toBeGreaterThan(0);
    expect(res.upfront).toBeCloseTo(res.deposit + res.stampDuty, 6);
    // Year 0: buyer's net = deposit (equity), renter's net = deposit + duty.
    expect(res.perYear[0]!.buyNet).toBeCloseTo(res.deposit, 6);
    expect(res.perYear[0]!.rentNet).toBeCloseTo(res.upfront, 6);
    expect(res.perYear[0]!.rentNet - res.perYear[0]!.buyNet).toBeCloseTo(
      res.stampDuty,
      6,
    );
  });

  it("clamps the horizon to 1..30", () => {
    expect(rentVsBuy({ ...BASE, horizonYears: 0 }).perYear).toHaveLength(2); // clamped to 1
    expect(
      rentVsBuy({ ...BASE, horizonYears: 999 }).perYear,
    ).toHaveLength(RENT_VS_BUY_MAX_HORIZON + 1);
  });
});

describe("rentVsBuy — required scenarios", () => {
  it("rent wins with 0% appreciation (buying never catches up)", () => {
    const res = rentVsBuy({ ...BASE, appreciationPct: 0, horizonYears: 10 });
    expect(res.rentNetFinal).toBeGreaterThan(res.buyNetFinal);
    expect(res.difference).toBeLessThan(0);
    expect(res.breakevenYear).toBeNull();
  });

  it("buy wins with high rent inflation (and hits a breakeven year)", () => {
    const res = rentVsBuy({
      ...BASE,
      rentInflationPct: 15,
      appreciationPct: 5,
      investmentReturnPct: 5,
      horizonYears: 20,
    });
    expect(res.buyNetFinal).toBeGreaterThan(res.rentNetFinal);
    expect(res.difference).toBeGreaterThan(0);
    expect(res.breakevenYear).not.toBeNull();
    expect(res.breakevenYear!).toBeGreaterThanOrEqual(1);
    expect(res.breakevenYear!).toBeLessThanOrEqual(20);
  });

  it("reports no breakeven when renting stays ahead the whole horizon", () => {
    // Cheap rent + strong investment returns + flat property ⇒ renting dominates.
    const res = rentVsBuy({
      ...BASE,
      weeklyRent: 300,
      appreciationPct: 0,
      rentInflationPct: 2,
      investmentReturnPct: 9,
      horizonYears: 15,
    });
    expect(res.breakevenYear).toBeNull();
    expect(res.perYear.every((p) => p.year === 0 || p.buyNet < p.rentNet)).toBe(
      true,
    );
  });

  it("handles a zero interest rate without NaN/Infinity", () => {
    const res = rentVsBuy({ ...BASE, mortgageRatePct: 0, horizonYears: 10 });
    // Zero-rate mortgage repays principal linearly over the term.
    expect(res.monthlyMortgage).toBeCloseTo((800_000 * 0.8) / 360, 4);
    expect(allFinite([res.buyNetFinal, res.rentNetFinal, res.difference])).toBe(
      true,
    );
    expect(
      allFinite(res.perYear.flatMap((p) => [p.buyNet, p.rentNet])),
    ).toBe(true);
  });

  it("supports a one-year horizon", () => {
    const res = rentVsBuy({ ...BASE, horizonYears: 1 });
    expect(res.perYear).toHaveLength(2); // years 0 and 1
    expect(res.perYear[1]!.year).toBe(1);
    expect(Number.isFinite(res.buyNetFinal)).toBe(true);
    expect(Number.isFinite(res.rentNetFinal)).toBe(true);
    // A year in, buying is still behind by roughly the (sunk) duty + costs.
    expect(res.breakevenYear).toBeNull();
  });
});

describe("rentVsBuy — monotonic sensitivities", () => {
  it("higher appreciation never hurts the buyer's final net", () => {
    const low = rentVsBuy({ ...BASE, appreciationPct: 2 });
    const high = rentVsBuy({ ...BASE, appreciationPct: 8 });
    expect(high.buyNetFinal).toBeGreaterThan(low.buyNetFinal);
  });

  it("higher investment returns never hurt the renter's final net", () => {
    const low = rentVsBuy({ ...BASE, investmentReturnPct: 3 });
    const high = rentVsBuy({ ...BASE, investmentReturnPct: 9 });
    expect(high.rentNetFinal).toBeGreaterThan(low.rentNetFinal);
  });

  it("a 100% deposit means no loan and no mortgage payment", () => {
    const res = rentVsBuy({ ...BASE, depositPct: 100 });
    expect(res.monthlyMortgage).toBe(0);
    expect(res.deposit).toBeCloseTo(800_000, 6);
    expect(Number.isFinite(res.buyNetFinal)).toBe(true);
  });

  it("invests the buyer's surplus when rent is higher than ownership costs", () => {
    const res = rentVsBuy({
      ...BASE,
      depositPct: 100,
      weeklyRent: 2_000,
      appreciationPct: 0,
      investmentReturnPct: 6,
      ownershipCostPct: 1,
      horizonYears: 5,
    });

    // With no loan and no appreciation, any buy-path net worth above the house
    // value must be the buyer investing the shared-budget surplus.
    expect(res.monthlyMortgage).toBe(0);
    expect(res.buyNetFinal).toBeGreaterThan(BASE.price);
    expect(res.difference).toBeGreaterThan(0);
    expect(res.breakevenYear).toBe(1);
  });
});
