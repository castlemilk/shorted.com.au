import { createSlug } from "@/lib/industry-slug";
import {
  PINNED_INDUSTRY_SLUGS,
  industryShortInterestSeriesKey,
} from "../industry-context";

const GICS_INDUSTRIES = [
  "Materials",
  "Energy",
  "Software & Services",
  "Financial Services",
  "Health Care Equipment & Services",
  "Pharmaceuticals, Biotechnology & Life Sciences",
  "Capital Goods",
  "Commercial & Professional Services",
  "Media & Entertainment",
  "Food, Beverage & Tobacco",
  "Consumer Discretionary Distribution & Retail",
  "Consumer Services",
  "Equity Real Estate Investment Trusts (REITs)",
  "Technology Hardware & Equipment",
  "Transportation",
  "Real Estate Management & Development",
  "Utilities",
  "Telecommunication Services",
  "Consumer Durables & Apparel",
  "Banks",
  "Household & Personal Products",
  "Insurance",
  "Automobiles & Components",
  "Consumer Staples Distribution & Retail",
  "Semiconductors & Semiconductor Equipment",
] as const;

describe("industry economy-series slug bridge", () => {
  it("pins exactly the collector's 25 GICS industry slugs", () => {
    const expected = GICS_INDUSTRIES.map(createSlug).sort();
    expect([...PINNED_INDUSTRY_SLUGS].sort()).toEqual(expected);
    expect(PINNED_INDUSTRY_SLUGS.size).toBe(25);
  });

  it("builds a derived key only for a pinned industry", () => {
    expect(industryShortInterestSeriesKey("Software & Services")).toBe(
      "markets.short_interest_avg.software-services.aus",
    );
    expect(industryShortInterestSeriesKey("Future GICS Group")).toBeNull();
  });
});
