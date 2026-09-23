import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import {
  GetSuburbProfileResponseSchema,
  LgaInfoSchema,
  LgaOverlapSchema,
  SuburbSummarySchema,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { councilHref, COUNCIL_PAGES_ENABLED, fmtCouncilShare } from "@/lib/housing/council";
import { SuburbCouncilCard, websiteLabel } from "./suburb-council-card";
import { SuburbProfile } from "./suburb-profile";

jest.mock("./suburb-banner-map", () => ({ SuburbBannerMap: () => null }));
jest.mock("./housing-charts", () => ({ HousingSeriesChart: () => null }));
jest.mock("./suburb-locator-map-loader", () => ({ SuburbLocatorMap: () => null }));
jest.mock("./suburb-recent-price-drops-loader", () => ({ RecentPriceDrops: () => null }));
jest.mock("@/components/politicians/suburb-politician-property-card-loader", () => ({
  SuburbPoliticianPropertyCard: () => null,
}));

// Kingsgrove, as the local DB serves it: a three-council straddler.
const kingsgrove = () =>
  create(LgaInfoSchema, {
    lgaCode: "11570", lgaName: "Canterbury-Bankstown", displayName: "Canterbury-Bankstown",
    stateCode: "NSW", slug: "canterbury-bankstown", kind: "council",
    population: 390_000, erpYear: 2025, popGrowthPct: 1.05, areaSqkm: 110,
    medianAge: 36, medianHhdIncome: 1556, medianWeeklyRent: 400,
    councilHouseMedian: 1_399_999, councilHouseMedianPeriod: "2023-24",
    fedFagAud: 9_500_000, fedFagYear: "2025-26",
    website: "https://www.cbcity.nsw.gov.au/", wikidataQid: "Q24070750",
    dominantShare: 0.4946,
  });
const overlaps = () => [
  create(LgaOverlapSchema, { lgaCode: "12930", displayName: "Georges River", stateCode: "NSW", slug: "georges-river", share: 0.278 }),
  create(LgaOverlapSchema, { lgaCode: "10500", displayName: "Bayside", stateCode: "NSW", slug: "bayside", share: 0.227 }),
];

const row = (label: RegExp | string) => screen.getByText(label).closest("div")!;

describe("SuburbCouncilCard", () => {
  test("names the council, its share, and every other council the suburb spans", () => {
    render(<SuburbCouncilCard council={kingsgrove()} overlaps={overlaps()} />);
    expect(row("Council (LGA)")).toHaveTextContent("Canterbury-Bankstown · 49% of residents");
    expect(row("Also spans")).toHaveTextContent("Georges River (28%), Bayside (23%)");
  });

  test("dates every council fact and labels the house median as council-wide", () => {
    render(<SuburbCouncilCard council={kingsgrove()} overlaps={overlaps()} />);
    expect(row("Population")).toHaveTextContent("390,000 (2025) · +1.1% in a year");
    expect(row("Council medians (2021)")).toHaveTextContent("age 36 · $1,556/wk household income · $400/wk rent");
    expect(row(/Council-wide house median \(2023-24\)/)).toHaveTextContent("$1.4M");
    // FAG per resident uses the ERP population, not a Census suburb sum.
    expect(row("Federal grants")).toHaveTextContent("$9.50M in 2025-26 · $24/resident");
    const site = screen.getByRole("link", { name: "cbcity.nsw.gov.au" });
    expect(site).toHaveAttribute("href", "https://www.cbcity.nsw.gov.au/");
    expect(site).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/ABS Estimated Resident Population 2025/)).toBeInTheDocument();
    expect(screen.getByText(/established-house transfers across the whole council, financial year 2023-24/)).toBeInTheDocument();
  });

  test("leaves out what no source covers, and a single-council suburb has no split", () => {
    const bare = create(LgaInfoSchema, { lgaCode: "10050", lgaName: "Albury", population: 59_538, erpYear: 2025, stateCode: "NSW" });
    render(<SuburbCouncilCard council={bare} />);
    expect(row("Council (LGA)")).toHaveTextContent(/^Council \(LGA\)Albury$/);
    expect(screen.queryByText("Also spans")).toBeNull();
    expect(screen.queryByText(/Council medians/)).toBeNull();
    expect(screen.queryByText(/house median/i)).toBeNull();
    expect(screen.queryByText("Website")).toBeNull();
    expect(row("Population")).toHaveTextContent("59,538 (2025)");
    expect(row("Population")).not.toHaveTextContent("in a year");
  });

  test("links to the council page only once council pages exist", () => {
    const { unmount } = render(<SuburbCouncilCard council={kingsgrove()} />);
    expect(screen.queryByRole("link", { name: "Canterbury-Bankstown" })).toBeNull();
    unmount();
    render(<SuburbCouncilCard council={kingsgrove()} pagesEnabled />);
    expect(screen.getByRole("link", { name: "Canterbury-Bankstown" })).toHaveAttribute(
      "href", "/housing/nsw/council/canterbury-bankstown",
    );
  });

  test("renders inside the suburb profile from the response's council_overlaps", () => {
    render(
      <SuburbProfile
        salCode="12166"
        profile={create(GetSuburbProfileResponseSchema, {
          summary: create(SuburbSummarySchema, { salCode: "12166", salName: "Kingsgrove", stateCode: "NSW" }),
          council: kingsgrove(),
          councilOverlaps: overlaps(),
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: /Local council/ })).toBeInTheDocument();
    expect(row("Also spans")).toHaveTextContent("Georges River (28%)");
  });
});

describe("council helpers", () => {
  test("council pages are off until the council hub ships", () => {
    expect(COUNCIL_PAGES_ENABLED).toBe(false);
    expect(councilHref("NSW", "albury")).toBeNull();
  });
  test("councilHref needs pages, a slug and a state with a housing route", () => {
    expect(councilHref("NSW", "albury", true)).toBe("/housing/nsw/council/albury");
    expect(councilHref("NSW", "", true)).toBeNull();
    expect(councilHref("OT", "christmas-island", true)).toBeNull();
  });
  test("a share never renders as 0%", () => {
    expect(fmtCouncilShare(0.004)).toBe("1%");
    expect(fmtCouncilShare(0.4946)).toBe("49%");
  });
  test("websiteLabel drops scheme, www and a trailing slash", () => {
    expect(websiteLabel("https://www.alburycity.nsw.gov.au/")).toBe("alburycity.nsw.gov.au");
    expect(websiteLabel("http://www.shire.gov.cx")).toBe("shire.gov.cx");
    expect(websiteLabel("not a url")).toBe("not a url");
  });
});
