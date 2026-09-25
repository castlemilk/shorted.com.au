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
jest.mock("./suburb-locator-map", () => ({ SuburbLocatorMap: () => null }));
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
    // QLD has no open flood layer: the card says so instead of showing 0%.
    expect(screen.queryByRole("article", { name: /flood planning area/ })).not.toBeInTheDocument();
    expect(section.textContent).toMatch(/No open statutory flood layer is published for Queensland/);
  });

  test("names only the hazard a state lacks, and credits the one it has", () => {
    render(
      <SuburbProfile
        salCode="30001"
        profile={profile({ stateCode: "QLD", hazards: { waterObservedSharePct: 2, bushfireProneSharePct: 35, bushfireSource: "qld_qfd_bpa" } })}
      />,
    );
    const section = screen.getByRole("heading", { name: /Terrain & hazard exposure/ }).closest("section")!;
    expect(screen.getByRole("article", { name: /Bushfire prone/ })).toHaveTextContent("35%");
    expect(screen.getByRole("article", { name: /Bushfire prone/ })).toHaveTextContent("QFD Bushfire Prone Area");
    expect(section.textContent).not.toMatch(/flood or bushfire layer/);
    expect(section.textContent).toMatch(/No open statutory flood layer is published for Queensland/);
  });

  test("a NSW suburb with no lodged flood map reads 'Not mapped', never 0%", () => {
    render(
      <SuburbProfile
        salCode="12353"
        profile={profile({ hazards: {
          waterObservedSharePct: 6, bushfireProneSharePct: 12,
          floodSource: "nsw_epi_flood", bushfireSource: "nsw_bfpl",
        } })}
      />,
    );
    const tile = screen.getByRole("article", { name: /flood planning area/ });
    expect(tile).toHaveTextContent("Not mapped");
    expect(tile).not.toHaveTextContent("0%");
    const section = tile.closest("section")!;
    expect(section.textContent).toMatch(/No flood map lodged in the NSW planning instruments for most of this suburb/);
    expect(section.textContent).not.toMatch(/No open statutory/);
  });

  test("a row from before a state's layer was loaded borrows no reason", () => {
    // Prod rows loaded before the gap-fill carry water shares and nothing
    // statutory for SA/TAS/ACT: null shares with no source. Deploying the web
    // first must not tell every one of those suburbs it is Evidence Required.
    for (const [stateCode, reason] of [
      ["SA", /Evidence Required|Regional or Outback/],
      ["TAS", /interim scheme|maps no flood-prone/],
      ["ACT", /modelled flood catchments/],
    ] as const) {
      const { unmount } = render(
        <SuburbProfile salCode="40001" profile={profile({ stateCode, hazards: { waterObservedSharePct: 4 } })} />,
      );
      const section = screen.getByRole("heading", { name: /Terrain & hazard exposure/ }).closest("section")!;
      expect(screen.queryByText("Not mapped")).not.toBeInTheDocument();
      expect(section.textContent).not.toMatch(reason);
      unmount();
    }
  });

  test("a TAS suburb mostly in Kingborough is not told its LPS maps no flood land", () => {
    render(
      <SuburbProfile
        salCode="60403"
        profile={profile({ stateCode: "TAS", hazards: {
          waterObservedSharePct: 1, floodSource: "tas_tps_flood_prone", bushfireSource: "tas_tps_bushfire_prone",
        } })}
      />,
    );
    const section = screen.getByRole("heading", { name: /Terrain & hazard exposure/ }).closest("section")!;
    expect(screen.getAllByText("Not mapped")).toHaveLength(2);
    expect(section.textContent).toMatch(/still on an interim scheme \(Kingborough\)/);
    expect(section.textContent).not.toMatch(/Local Provisions Schedule maps no/);
  });

  test("a masked state's share is described as a floor over the whole suburb", () => {
    render(
      <SuburbProfile
        salCode="40362"
        profile={profile({ stateCode: "SA", hazards: {
          floodPlanningSharePct: 30, floodSource: "sa_pdcode_hazards_flooding",
          bushfireProneSharePct: 0, bushfireSource: "sa_pdcode_hazards_bushfire",
        } })}
      />,
    );
    const section = screen.getByRole("heading", { name: /Terrain & hazard exposure/ }).closest("section")!;
    expect(section.textContent).toMatch(/proportion of the suburb's land area; where part of a suburb is unmapped, only its mapped land counts, so the share is a floor/);
    expect(screen.getByRole("article", { name: /flood planning area/ })).toHaveTextContent("Flooding – General");
  });

  test("a suburb with no hazards row claims nothing about coverage", () => {
    render(
      <SuburbProfile
        salCode="12353"
        profile={profile({ elevation: { elevationMedianM: 12 } })}
      />,
    );
    expect(screen.queryByRole("article", { name: /flood planning area/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/No flood map lodged/)).not.toBeInTheDocument();
  });

  test("the ACT flood layer is described as a modelled extent, not a planning control", () => {
    render(
      <SuburbProfile
        salCode="80001"
        profile={profile({ stateCode: "ACT", hazards: { floodPlanningSharePct: 4, floodSource: "act_flood_extent_1pct_aep" } })}
      />,
    );
    const section = screen.getByRole("heading", { name: /Terrain & hazard exposure/ }).closest("section")!;
    expect(section.textContent).toMatch(/modelled 1% AEP flood extent/);
    expect(section.textContent).not.toMatch(/not a flood extent/);
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
