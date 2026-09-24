import { priceSeriesGap } from "./price-coverage";

describe("priceSeriesGap", () => {
  test("never promises a series that is not coming", () => {
    for (const st of ["NSW", "VIC", "SA", "QLD", "WA", "TAS", "NT", "ACT"]) {
      const gap = priceSeriesGap(st, st, "Somewhere");
      expect(`${gap.headline} ${gap.detail}`).not.toMatch(/\byet\b/i);
    }
  });

  test("QLD and WA are commercially licensed, not unbuilt", () => {
    expect(priceSeriesGap("QLD", "Queensland", "Paddington").detail).toMatch(/licensed brokers/);
    expect(priceSeriesGap("WA", "Western Australia", "Subiaco").detail).toMatch(/licensed brokers/);
  });

  test("TAS, NT and ACT publish no open feed", () => {
    for (const st of ["TAS", "NT", "ACT"]) {
      expect(priceSeriesGap(st, st, "X").detail).toMatch(/no open Valuer-General sales feed/);
    }
  });

  test("small NSW and VIC localities get no unverified explanation for a missing median", () => {
    const gap = priceSeriesGap("NSW", "New South Wales", "Tiny Creek");
    expect(gap.headline).toBe("No Valuer-General median for Tiny Creek.");
    expect(gap.detail).toMatch(/we have no suburb median for Tiny Creek/);
    expect(gap.detail).not.toMatch(/enough settled house sales|rarely has them/);
    expect(priceSeriesGap("VIC", "Victoria", "Tiny Creek").detail).toMatch(/we have no suburb median for Tiny Creek/);
  });

  // Mayfield (Newcastle) has 9,760 people and plenty of sales; it is unpriced
  // because its VG series was linked to a 36-person Mayfield elsewhere. Telling
  // it "not enough sales" would be a false reason.
  test("a populous or unknown-size suburb is never given the thin-sales reason", () => {
    for (const [st, name] of [["NSW", "Mayfield"], ["VIC", "Somewhere"], ["NSW", "Unknown"]] as const) {
      const gap = priceSeriesGap(st, st, name);
      expect(gap.detail).not.toMatch(/sales in one period|rarely has them|does not have them/);
      expect(gap.detail).toMatch(new RegExp(`no suburb median for ${name}`));
    }
  });

  // SA's open feed is "Metropolitan Median House Sales": a regional town such
  // as Mount Gambier (25,591 people) is unpriced because the feed never covers
  // it, not because its sales are thin.
  test("SA names the metropolitan-only coverage, whatever the suburb's size", () => {
    for (const name of ["Mount Gambier", "Adelaide"]) {
      const gap = priceSeriesGap("SA", "South Australia", name);
      expect(gap.detail).toMatch(/metropolitan Adelaide only/);
      expect(gap.detail).not.toMatch(/does not have them|rarely has them/);
    }
  });
});
