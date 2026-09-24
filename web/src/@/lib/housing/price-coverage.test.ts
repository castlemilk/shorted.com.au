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

  test("in a priced state the gap is thin sales, not a missing source", () => {
    const gap = priceSeriesGap("NSW", "New South Wales", "Tiny Creek");
    expect(gap.headline).toBe("No Valuer-General median for Tiny Creek.");
    expect(gap.detail).toMatch(/enough settled house sales/);
  });
});
