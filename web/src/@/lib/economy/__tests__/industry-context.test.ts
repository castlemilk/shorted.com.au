import { createSlug } from "@/lib/industry-slug";
import {
  industryShortInterestSeriesKey,
  industrySlugFromShortInterestSeriesKey,
} from "../industry-context";

describe("industry economy-series slug bridge", () => {
  it.each([
    ["Materials", "materials"],
    ["Software & Services", "software-services"],
    [
      "Equity Real Estate Investment Trusts (REITs)",
      "equity-real-estate-investment-trusts-reits",
    ],
  ])("uses the canonical industry slug for %s", (industryName, expectedSlug) => {
    expect(createSlug(industryName)).toBe(expectedSlug);

    const seriesKey = industryShortInterestSeriesKey(industryName);
    expect(seriesKey).toBe(
      `markets.short_interest_avg.${expectedSlug}.aus`,
    );
    expect(industrySlugFromShortInterestSeriesKey(seriesKey)).toBe(
      expectedSlug,
    );
  });

  it("rejects unrelated economy keys on the reverse bridge", () => {
    expect(
      industrySlugFromShortInterestSeriesKey(
        "markets.short_interest_wavg.wa",
      ),
    ).toBeNull();
  });
});
