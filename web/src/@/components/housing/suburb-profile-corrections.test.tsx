import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import {
  GetSuburbProfileResponseSchema,
  SuburbAmenitiesSchema,
  SuburbCrimeSchema,
  SuburbCrimeStatSchema,
  SuburbDemographicsSchema,
  SuburbSummarySchema,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { CrimeCard, SuburbProfile } from "./suburb-profile";

jest.mock("./suburb-banner-map", () => ({ SuburbBannerMap: () => null }));
jest.mock("./housing-charts", () => ({ HousingSeriesChart: () => null }));
jest.mock("./suburb-locator-map-loader", () => ({ SuburbLocatorMap: () => null }));
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
  test("says why there is no median, per state, and never 'yet'", () => {
    const { unmount } = render(<SuburbProfile salCode="32250" profile={profile({ salName: "Paddington (Qld)", stateCode: "QLD" })} />);
    expect(screen.getByText(/licensed brokers/)).toBeInTheDocument();
    expect(screen.queryByText(/\byet\b/)).not.toBeInTheDocument();
    unmount();

    render(<SuburbProfile salCode="60001" profile={profile({ salName: "Hobart", stateCode: "TAS" })} />);
    expect(screen.getByText(/no open Valuer-General sales feed/)).toBeInTheDocument();
  });
});
