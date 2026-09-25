import { create } from "@bufbuild/protobuf";
import { render, screen, within } from "@testing-library/react";
import {
  ComparisonBaselinesSchema,
  GetSuburbProfileResponseSchema,
  StateCensusAveragesSchema,
  SuburbAmenitiesSchema,
  SuburbCrimeSchema,
  SuburbCrimeStatSchema,
  SuburbDemographicsSchema,
  SuburbSummarySchema,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { CrimeCard, SuburbProfile } from "./suburb-profile";

jest.mock("./suburb-banner-map", () => ({ SuburbBannerMap: () => null }));
jest.mock("./housing-charts", () => ({ HousingSeriesChart: () => null }));
jest.mock("./suburb-locator-map", () => ({ SuburbLocatorMap: () => null }));
jest.mock("./suburb-recent-price-drops-loader", () => ({ RecentPriceDrops: () => null }));
jest.mock("@/components/politicians/suburb-politician-property-card-loader", () => ({
  SuburbPoliticianPropertyCard: () => null,
}));

type Opts = { salName?: string; stateCode?: string; population?: number; nbn?: string };

const profile = ({ salName = "Bondi", stateCode = "NSW", population = 10_411, nbn = "" }: Opts) =>
  create(GetSuburbProfileResponseSchema, {
    summary: create(SuburbSummarySchema, {
      salCode: "10462", salName, stateCode, dominantNbnTech: nbn,
      amenities: create(SuburbAmenitiesSchema, { schoolsTotal: 3, supermarketsTotal: 2, parksCount: 9 }),
    }),
    demographics: create(SuburbDemographicsSchema, { population }),
  });

const nbnTile = () => screen.queryByText("NBN");

describe("NBN tile", () => {
  test("a populous suburb classed Satellite shows no NBN tile rather than a false fact", () => {
    render(<SuburbProfile salCode="10462" profile={profile({ nbn: "Satellite", population: 10_411 })} />);
    expect(screen.getByText("Schools")).toBeInTheDocument(); // the amenities grid rendered
    expect(nbnTile()).not.toBeInTheDocument();
    expect(screen.queryByText("SATELLITE")).not.toBeInTheDocument();
  });

  test("a remote satellite suburb and a fixed-line suburb keep their tile", () => {
    const { unmount } = render(
      <SuburbProfile salCode="70001" profile={profile({ salName: "Kintore", stateCode: "NT", nbn: "Satellite", population: 400 })} />,
    );
    expect(nbnTile()).toBeInTheDocument();
    expect(screen.getByText("SATELLITE")).toBeInTheDocument();
    unmount();

    render(<SuburbProfile salCode="10462" profile={profile({ nbn: "Fixed Line" })} />);
    expect(screen.getByText("FIXED LINE")).toBeInTheDocument();
  });
});

describe("suburb name", () => {
  // The banner's subtitle is the line directly under the h1.
  const subtitle = () => screen.getByRole("heading", { level: 1 }).nextElementSibling;

  test("the h1 carries the ABS name as delivered, never re-cased", () => {
    render(<SuburbProfile salCode="21524" profile={profile({ salName: "McCrae", stateCode: "VIC" })} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^McCrae$/);
  });

  test("a state-only qualifier leaves the h1 — the subtitle already names the state", () => {
    render(<SuburbProfile salCode="32250" profile={profile({ salName: "Paddington (Qld)", stateCode: "QLD" })} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Paddington$/);
    expect(screen.queryByText(/\(qld\)/)).not.toBeInTheDocument(); // the old lowercased mangling
    expect(subtitle()).toHaveTextContent(/^Queensland$/);
  });

  test("an LGA qualifier moves into the subtitle", () => {
    render(<SuburbProfile salCode="11687" profile={profile({ salName: "Glenroy (Albury - NSW)" })} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Glenroy$/);
    expect(subtitle()).toHaveTextContent(/^Albury · New South Wales$/);
  });

  test("MP surnames are title-cased while the ABS place name is preserved", () => {
    const p = profile({ salName: "McCrae", stateCode: "VIC" });
    Object.assign(p.summary!, {
      federalMember: "Fiona PHILLIPS", federalDivision: "Gilmore",
      stateMember: "Gabrielle de Vietri", stateDistrict: "Richmond",
    });
    render(<SuburbProfile salCode="21524" profile={p} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^McCrae$/);
    expect(screen.getByText("Fiona Phillips")).toBeInTheDocument();
    expect(screen.getByText("Gabrielle de Vietri")).toBeInTheDocument();
    expect(screen.queryByText("Fiona PHILLIPS")).not.toBeInTheDocument();
  });
});

describe("crime card", () => {
  const crime = (types: string[]) =>
    create(SuburbCrimeSchema, {
      stats: types.map((crimeType, i) =>
        create(SuburbCrimeStatSchema, { crimeType, ratePer100k: 900 + i, pctRank: 40 + i, fyEnding: 2025 }),
      ),
    });

  test("property damage has a proper label, and four types sit in a four-up grid", () => {
    const { container } = render(<CrimeCard crime={crime(["break_ins", "motor_vehicle", "property_damage", "violent"])} />);
    expect(screen.getByText("Property damage")).toBeInTheDocument();
    expect(screen.queryByText("property damage")).not.toBeInTheDocument();
    const grid = container.querySelector(".grid")!;
    expect(grid.className).toContain("lg:grid-cols-4");
    expect(grid.className).not.toContain("grid-cols-3");
  });

  test("three types keep the three-column grid; an unknown type still reads as a label", () => {
    const { container } = render(<CrimeCard crime={crime(["break_ins", "fraud_and_deception", "violent"])} />);
    expect(container.querySelector(".grid")!.className).toContain("sm:grid-cols-3");
    expect(screen.getByText("Fraud and deception")).toBeInTheDocument();
  });
});

describe("unpriced suburb", () => {
  test.each([
    ["NSW", "Mayfield (Newcastle - NSW)", 9_760, /we have no suburb median/],
    ["VIC", "Tiny Creek", 120, /we have no suburb median/],
    ["SA", "Mount Gambier", 25_591, /metropolitan Adelaide only/],
  ] as const)("%s profile explains coverage without assuming thin sales", (stateCode, salName, population, reason) => {
    render(<SuburbProfile salCode="10462" profile={profile({ stateCode, salName, population })} />);
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/does not have them|rarely has them/)).not.toBeInTheDocument();
  });

  test("says why there is no median, per state, and never 'yet'", () => {
    const { unmount } = render(<SuburbProfile salCode="32250" profile={profile({ salName: "Paddington (Qld)", stateCode: "QLD" })} />);
    expect(screen.getByText(/licensed brokers/)).toBeInTheDocument();
    expect(screen.queryByText(/\byet\b/)).not.toBeInTheDocument();
    unmount();

    render(<SuburbProfile salCode="60001" profile={profile({ salName: "Hobart", stateCode: "TAS" })} />);
    expect(screen.getByText(/no open Valuer-General sales feed/)).toBeInTheDocument();
  });
});

describe("comparison baselines", () => {
  const priced = (baselines: Parameters<typeof create<typeof ComparisonBaselinesSchema>>[1]) => {
    const p = profile({});
    p.summary!.latestMedianPrice = 3_400_000;
    p.summary!.yoyPct = 4.1;
    p.summary!.regionCode = "SUBURB:NSW-BONDI";
    p.demographics!.medianWeeklyHhdIncome = 2_600;
    p.baselines = create(ComparisonBaselinesSchema, baselines);
    return p;
  };

  test("price references are the ABS capital and rest-of-state medians, never an 'AU' average", () => {
    render(<SuburbProfile salCode="10462" profile={priced({
      capitalMedianPrice: 1_485_000, capitalRegionName: "Greater Sydney", capitalRegionCode: "1GSYD",
      restOfStateMedianPrice: 825_000, restOfStateRegionName: "Rest of NSW", absMedianPeriod: "2026-03-31",
      stateMedianWeeklyHhdIncome: 1_583, nationalMedianWeeklyHhdIncome: 1_540,
    })} />);
    const bar = screen.getByText("Median house price", { selector: "span" }).closest("div")!.parentElement!;
    expect(bar).toHaveTextContent("vs Greater Sydney");
    expect(bar).toHaveTextContent("vs Rest of NSW");
    expect(bar).not.toHaveTextContent(/vs AU\b/);
    expect(within(bar).getByRole("link", { name: /Greater Sydney/ })).toHaveAttribute("href", "/housing/capitals/greater-sydney");
    expect(screen.getByText(/ABS median established-house transfer prices for the Mar 2026 quarter/)).toBeInTheDocument();
    expect(screen.queryByText(/average of the latest suburb medians/)).not.toBeInTheDocument();
  });

  test("income references are named as the median suburb", () => {
    render(<SuburbProfile salCode="10462" profile={priced({ stateMedianWeeklyHhdIncome: 1_583, nationalMedianWeeklyHhdIncome: 1_540 })} />);
    expect(screen.getByRole("link", { name: /NSW median suburb/ })).toBeInTheDocument();
    expect(screen.getByText(/AU median suburb/)).toBeInTheDocument();
  });

  test("the household cards are mounted from the same response", () => {
    const p = priced({ stateCensus: create(StateCensusAveragesSchema, { pctRented: 32.7, pctOwnedOutright: 31.4, pctOwnedMortgage: 32.6 }) });
    Object.assign(p.demographics!, { dwellingCount: 4_921, pctOwnedOutright: 17, pctOwnedMortgage: 18, pctRented: 61, unemploymentRate: 3.2 });
    render(<SuburbProfile salCode="10462" profile={p} />);
    expect(screen.getByRole("heading", { name: /Housing stock/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Who lives here/ })).toBeInTheDocument();
    expect(screen.getByText(/NSW: 31% owned outright/)).toBeInTheDocument();
  });
});
