import { describe, it, expect } from "@jest/globals";
import {
  calculateStampDuty,
  isStampDutyState,
  stampDutyInfo,
  STAMP_DUTY_STATES,
} from "./stamp-duty";

/**
 * Known-value regression tests. Expected values are computed by hand from the
 * bracket tables baked in stamp-duty.ts — they pin the schedules so an
 * accidental edit to a rate or base is caught here.
 */
describe("calculateStampDuty", () => {
  it("NSW", () => {
    expect(calculateStampDuty("NSW", 10_000)).toBeCloseTo(125, 2);
    expect(calculateStampDuty("NSW", 400_000)).toBeCloseTo(12_530, 2);
    expect(calculateStampDuty("NSW", 750_000)).toBeCloseTo(28_280, 2);
    // Minimum duty floor.
    expect(calculateStampDuty("NSW", 100)).toBeCloseTo(20, 2);
  });

  it("VIC", () => {
    expect(calculateStampDuty("VIC", 20_000)).toBeCloseTo(280, 2);
    expect(calculateStampDuty("VIC", 750_000)).toBeCloseTo(40_070, 2);
    // Flat 5.5% of the WHOLE value in the $960k–$2M range.
    expect(calculateStampDuty("VIC", 1_200_000)).toBeCloseTo(66_000, 2);
  });

  it("QLD", () => {
    expect(calculateStampDuty("QLD", 4_000)).toBe(0);
    expect(calculateStampDuty("QLD", 300_000)).toBeCloseTo(8_925, 2);
    expect(calculateStampDuty("QLD", 700_000)).toBeCloseTo(24_525, 2);
  });

  it("WA (residential rate)", () => {
    expect(calculateStampDuty("WA", 200_000)).toBeCloseTo(3_800, 2);
    expect(calculateStampDuty("WA", 500_000)).toBeCloseTo(13_490, 2);
    expect(calculateStampDuty("WA", 750_000)).toBeCloseTo(25_465, 2);
  });

  it("SA", () => {
    expect(calculateStampDuty("SA", 80_000)).toBeCloseTo(2_130, 2);
    expect(calculateStampDuty("SA", 450_000)).toBeCloseTo(18_830, 2);
    expect(calculateStampDuty("SA", 600_000)).toBeCloseTo(26_830, 2);
  });

  it("TAS", () => {
    expect(calculateStampDuty("TAS", 2_000)).toBeCloseTo(50, 2);
    expect(calculateStampDuty("TAS", 150_000)).toBeCloseTo(4_185, 2);
    expect(calculateStampDuty("TAS", 600_000)).toBeCloseTo(22_497.5, 2);
  });

  it("ACT (owner-occupier)", () => {
    expect(calculateStampDuty("ACT", 400_000)).toBeCloseTo(5_320, 2);
    expect(calculateStampDuty("ACT", 750_000)).toBeCloseTo(19_520, 2);
    // Flat rate on the whole value above the top threshold.
    expect(calculateStampDuty("ACT", 1_600_000)).toBeCloseTo(72_640, 2);
  });

  it("NT (quadratic formula below $525k, flat above)", () => {
    // D = 0.06571441·V² + 15·V, V = 500 → 16,428.6025 + 7,500.
    expect(calculateStampDuty("NT", 500_000)).toBeCloseTo(23_928.6, 1);
    expect(calculateStampDuty("NT", 1_000_000)).toBeCloseTo(49_500, 2);
    expect(calculateStampDuty("NT", 4_000_000)).toBeCloseTo(230_000, 2);
  });

  it("returns 0 for non-positive prices", () => {
    for (const st of STAMP_DUTY_STATES) {
      expect(calculateStampDuty(st, 0)).toBe(0);
      expect(calculateStampDuty(st, -5)).toBe(0);
    }
  });

  it("is monotonically non-decreasing in price for every state", () => {
    const prices = [1_000, 50_000, 200_000, 500_000, 750_000, 1_000_000, 2_500_000, 6_000_000];
    for (const st of STAMP_DUTY_STATES) {
      let prev = 0;
      for (const p of prices) {
        const d = calculateStampDuty(st, p);
        expect(d).toBeGreaterThanOrEqual(prev);
        prev = d;
      }
    }
  });
});

describe("stampDutyInfo / isStampDutyState", () => {
  it("every state has a concession note and a revenue-office source", () => {
    for (const st of STAMP_DUTY_STATES) {
      const info = stampDutyInfo(st);
      expect(info.concessionNote.length).toBeGreaterThan(10);
      expect(info.sourceUrl).toMatch(/^https:\/\//);
    }
  });
  it("guards search-param input", () => {
    expect(isStampDutyState("NSW")).toBe(true);
    expect(isStampDutyState("nsw")).toBe(false);
    expect(isStampDutyState("XX")).toBe(false);
  });
});
