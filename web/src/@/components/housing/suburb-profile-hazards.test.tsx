import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import {
  GetSuburbProfileResponseSchema,
  SuburbElevationSchema,
  SuburbHazardExposureSchema,
  SuburbSummarySchema,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { SuburbProfile } from "./suburb-profile";
import { fmtShare } from "./suburb-hazard-card";

jest.mock("./suburb-banner-map", () => ({ SuburbBannerMap: () => null }));
jest.mock("./housing-charts", () => ({ HousingSeriesChart: () => null }));
jest.mock("./suburb-locator-map-loader", () => ({ SuburbLocatorMap: () => null }));
jest.mock("./suburb-recent-price-drops-loader", () => ({ RecentPriceDrops: () => null }));
jest.mock("@/components/politicians/suburb-politician-property-card-loader", () => ({
  SuburbPoliticianPropertyCard: () => null,
}));

const profile = (opts: { elevation?: object; hazards?: object; stateCode?: string }) =>
  create(GetSuburbProfileResponseSchema, {
    summary: create(SuburbSummarySchema, {
      salCode: "10001", salName: "WINDSOR", postcode: "2756", stateCode: opts.stateCode ?? "NSW",
    }),
    elevation: opts.elevation ? create(SuburbElevationSchema, opts.elevation) : undefined,
    hazards: opts.hazards ? create(SuburbHazardExposureSchema, opts.hazards) : undefined,
  });

describe("Terrain & hazard exposure card", () => {
  test("renders elevation and every measured share, including a genuine zero", () => {
    render(
      <SuburbProfile
        salCode="10001"
        profile={profile({
          elevation: { elevationMinM: 2, elevationMedianM: 14.4, elevationMaxM: 40, landShareBelow5m: 12.3, landShareBelow2m: 0 },
          hazards: {
            waterObservedSharePct: 3.25, permanentWaterSharePct: 1,
            floodPlanningSharePct: 0, bushfireProneSharePct: 41,
            floodSource: "nsw_epi_flood", bushfireSource: "nsw_bfpl",
          },
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: /Terrain & hazard exposure/ })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Median elevation" })).toHaveTextContent("14 m");
    expect(screen.getByRole("article", { name: "Land below 5 m" })).toHaveTextContent("12%");
    expect(screen.getByRole("article", { name: /Observed under water/ })).toHaveTextContent("3.3%");
    // A measured zero is a fact, not a hole in the grid.
    expect(screen.getByRole("article", { name: /flood planning area/ })).toHaveTextContent("0%");
    expect(screen.getByRole("article", { name: /Bushfire prone/ })).toHaveTextContent("41%");
    expect(screen.getByRole("article", { name: /flood planning area/ })).toHaveTextContent("NSW EPI Flood");
    // The map deep link carries the overlay so the reader lands on the layer.
    const links = screen.getAllByRole("link", { name: /Show on map/ });
    expect(links.map((l) => l.getAttribute("href"))).toContain("/housing/nsw?sal=10001&overlays=flood_planning");
  });

  test("never describes the satellite share as flood risk", () => {
    render(
      <SuburbProfile
        salCode="30001"
        profile={profile({ stateCode: "QLD", hazards: { waterObservedSharePct: 8 } })}
      />,
    );
    const section = screen.getByRole("heading", { name: /Terrain & hazard exposure/ }).closest("section")!;
    expect(section.textContent).not.toMatch(/flood risk/i);
    expect(section.textContent).toMatch(/observed/i);
    // No statutory layer for QLD: the card says so instead of showing 0%.
    expect(screen.queryByRole("article", { name: /flood planning area/ })).not.toBeInTheDocument();
    expect(section.textContent).toMatch(/No open statutory flood or bushfire layer is published for Queensland/);
  });

  test("is absent when neither terrain nor hazard data exists", () => {
    render(<SuburbProfile salCode="10001" profile={profile({})} />);
    expect(screen.queryByRole("heading", { name: /Terrain & hazard exposure/ })).not.toBeInTheDocument();
  });

  test("share formatting keeps small non-zero values visible", () => {
    expect(fmtShare(0)).toBe("0%");
    expect(fmtShare(0.02)).toBe("<0.1%");
    expect(fmtShare(3.25)).toBe("3.3%");
    expect(fmtShare(41.6)).toBe("42%");
  });
});
