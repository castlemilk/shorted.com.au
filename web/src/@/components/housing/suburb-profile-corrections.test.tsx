import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import {
  GetSuburbProfileResponseSchema,
  SuburbAmenitiesSchema,
  SuburbDemographicsSchema,
  SuburbSummarySchema,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { SuburbProfile } from "./suburb-profile";

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
