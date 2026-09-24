import { readFileSync } from "node:fs";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { render, screen, within } from "@testing-library/react";
import {
  GetSuburbProfileResponseSchema,
  SuburbPlanningSchema,
  SuburbSummarySchema,
  ZoneFamilyShareSchema,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { planningCreditIds } from "@/lib/housing/planning-sources";
import { SuburbProfile, SourcesLine } from "./suburb-profile";
import { SuburbPlanningCard, fmtLot, fmtRatio } from "./suburb-planning-card";

jest.mock("./suburb-banner-map", () => ({ SuburbBannerMap: () => null }));
jest.mock("./housing-charts", () => ({ HousingSeriesChart: () => null }));
jest.mock("./suburb-locator-map-loader", () => ({ SuburbLocatorMap: () => null }));
jest.mock("./suburb-recent-price-drops-loader", () => ({ RecentPriceDrops: () => null }));
jest.mock("@/components/politicians/suburb-politician-property-card-loader", () => ({
  SuburbPoliticianPropertyCard: () => null,
}));

const planning = (fields: Record<string, unknown>) =>
  create(SuburbPlanningSchema, {
    ...fields,
    zoneShares: ((fields.zoneShares as { family: string; sharePct: number }[] | undefined) ?? []).map((z) =>
      create(ZoneFamilyShareSchema, z)),
  });

const nswFields = {
  zoneShares: [
    { family: "res_low", sharePct: 62.4 },
    { family: "open_space", sharePct: 20 },
    { family: "centre_mixed", sharePct: 9.6 },
  ],
  zoningCoveragePct: 92,
  dominantZoneFamily: "res_low",
  heritageSharePct: 0,
  heritageItemCount: 14,
  nswHeightMedianM: 9.5,
  nswHeightMaxM: 21.5,
  nswFsrMedian: 0.5,
  nswMinLotMedianM2: 450,
  nswHeightMappedPct: 64.8,
  nswFsrMappedPct: 100,
  nswMinLotMappedPct: 99.2,
  instruments: ["Ku-ring-gai Local Environmental Plan 2015"],
  zoningSource: "nsw_epi_land_zoning",
  heritageSource: "nsw_epi_heritage",
  sourceLicence: "CC-BY",
};
const nsw = planning(nswFields);

describe("Planning & zoning card", () => {
  test("renders the zoning mix as a stacked bar with labels, plus heritage and NSW controls", () => {
    render(<SuburbPlanningCard planning={nsw} stateCode="NSW" salCode="12345" />);
    expect(screen.getByRole("heading", { name: /Planning & zoning/ })).toBeInTheDocument();
    const bar = screen.getByRole("img", { name: /Zoning mix/ });
    const segments = bar.querySelectorAll("[data-family]");
    expect([...segments].map((s) => s.getAttribute("data-family"))).toEqual(["res_low", "open_space", "centre_mixed"]);
    expect((segments[0] as HTMLElement).style.width).toBe("62.4%");
    expect(screen.getByText("Low-density residential")).toBeInTheDocument();
    // coverage < 100: the shortfall is explained, not hidden
    expect(screen.getByText(/8\.0% of the suburb sits outside any mapped zone/)).toBeInTheDocument();
    // a measured 0 heritage share renders as 0%, not as absent
    expect(screen.getByRole("article", { name: "In a heritage area" })).toHaveTextContent("0%");
    expect(screen.getByRole("article", { name: "Listed heritage places" })).toHaveTextContent("14");
    expect(screen.getByRole("article", { name: "Max building height" })).toHaveTextContent("9.5 m");
    expect(screen.getByRole("article", { name: "Max building height" })).toHaveTextContent("up to 21.5 m");
    expect(screen.getByRole("article", { name: "Floor space ratio" })).toHaveTextContent("0.5:1");
    expect(screen.getByRole("article", { name: "Minimum lot size" })).toHaveTextContent("450 m²");
    expect(screen.getByText(/Ku-ring-gai Local Environmental Plan 2015/)).toBeInTheDocument();
    expect(
      screen.getByText(/Source: NSW EPI Land Zoning; NSW EPI Heritage; NSW EPI Height of Buildings, Floor Space Ratio and Lot Size/),
    ).toBeInTheDocument();
  });

  test("says what share of residential land a standard is mapped on, only when it is not nearly all", () => {
    render(<SuburbPlanningCard planning={nsw} stateCode="NSW" salCode="12345" />);
    expect(screen.getByRole("article", { name: "Max building height" })).toHaveTextContent("mapped on 65% of residential land");
    expect(screen.getByRole("article", { name: "Floor space ratio" })).not.toHaveTextContent(/mapped on/);
    expect(screen.getByRole("article", { name: "Minimum lot size" })).not.toHaveTextContent(/mapped on/);
    expect(screen.getByText(/where the LEP maps that standard, given only where it maps it on at least half/)).toBeInTheDocument();
  });

  test("a standard mapped on a sliver of residential land is not shown, and the card says why", () => {
    // Castle Hill: the LEP maps FSR on 4.9% of the residential land — the centre.
    render(
      <SuburbPlanningCard
        planning={planning({ ...nswFields, nswFsrMedian: undefined, nswFsrMappedPct: 4.9 })}
        stateCode="NSW" salCode="10846"
      />,
    );
    expect(screen.queryByRole("article", { name: "Floor space ratio" })).not.toBeInTheDocument();
    expect(screen.getByText(/under half of the suburb's residential land .*: floor space ratio \(4\.9%\)/)).toBeInTheDocument();
  });

  test("a suburb the zoning map barely reaches shows only that, never a 0% heritage", () => {
    // The Rocks: 2.9% in the Sydney LEP; the build stores the coverage alone.
    render(
      <SuburbPlanningCard
        planning={planning({
          zoningCoveragePct: 2.926,
          zoningSource: "nsw_epi_land_zoning",
          instruments: ["Sydney Local Environmental Plan 2012"],
        })}
        stateCode="NSW" salCode="13856"
      />,
    );
    expect(screen.getByText(/covers only 2\.9% of this suburb/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Zoning mix/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "In a heritage area" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Listed heritage places" })).not.toBeInTheDocument();
    expect(screen.getByText(/Source: NSW EPI Land Zoning\./)).toBeInTheDocument();
  });

  test("the listed-places note names the list, because the lists are not alike", () => {
    const { rerender } = render(<SuburbPlanningCard planning={nsw} stateCode="NSW" salCode="12345" />);
    expect(screen.getByRole("article", { name: "Listed heritage places" })).toHaveTextContent("items in the LEP heritage schedule");
    expect(screen.getByText(/do not compare across states/)).toBeInTheDocument();
    rerender(
      <SuburbPlanningCard
        planning={planning({ heritageItemCount: 15, heritageSource: "qld_heritage_register" })}
        stateCode="QLD" salCode="30001"
      />,
    );
    expect(screen.getByRole("article", { name: "Listed heritage places" })).toHaveTextContent("State-listed only");
  });

  test("links the zoning overlay on the state map", () => {
    render(<SuburbPlanningCard planning={nsw} stateCode="NSW" salCode="12345" />);
    const links = screen.getAllByRole("link", { name: /Show on map/ });
    expect(links[0]).toHaveAttribute("href", "/housing/nsw?sal=12345&overlays=zoning");
    expect(links[1]).toHaveAttribute("href", "/housing/nsw?sal=12345&overlays=heritage");
  });

  test("QLD heritage-only: no zoning bar, no controls, and says why", () => {
    render(
      <SuburbPlanningCard
        planning={planning({ heritageItemCount: 3, heritageSource: "qld_heritage_register" })}
        stateCode="QLD" salCode="30001"
      />,
    );
    expect(screen.queryByRole("img", { name: /Zoning mix/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "In a heritage area" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Listed heritage places" })).toHaveTextContent("3");
    expect(screen.queryByRole("article", { name: "Max building height" })).not.toBeInTheDocument();
    expect(screen.getByText(/no statewide zoning map/)).toBeInTheDocument();
  });

  test("renders nothing when the block is absent or empty", () => {
    const { container, rerender } = render(<SuburbPlanningCard stateCode="WA" salCode="50001" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SuburbPlanningCard planning={planning({ zoningCoveragePct: 0 })} stateCode="NSW" salCode="10001" />);
    expect(container).toBeEmptyDOMElement();
  });

  test("is mounted in the profile after the hazard card", () => {
    const profile = create(GetSuburbProfileResponseSchema, {
      summary: create(SuburbSummarySchema, { salCode: "12345", salName: "WAHROONGA", stateCode: "NSW" }),
      planning: nsw,
    });
    render(<SuburbProfile salCode="12345" profile={profile} />);
    const section = screen.getByRole("heading", { name: /Planning & zoning/ }).closest("section")!;
    expect(within(section).getByText("Centres & mixed use")).toBeInTheDocument();
    const source = readFileSync(join(__dirname, "suburb-profile.tsx"), "utf8");
    expect(source.indexOf("<SuburbPlanningCard")).toBeGreaterThan(source.indexOf("<SuburbHazardCard"));
  });

  test("the card stays a server component: no hooks, no Connect", () => {
    const source = readFileSync(join(__dirname, "suburb-planning-card.tsx"), "utf8");
    expect(source).not.toMatch(/^"use client"/m);
    expect(source).not.toMatch(/@connectrpc/);
    expect(source).not.toMatch(/\buse(State|Effect|Memo|Query)\b/);
  });

  test("formats plain-language control values", () => {
    expect(fmtLot(450)).toBe("450 m²");
    expect(fmtLot(20_000)).toBe("2 ha");
    expect(fmtLot(4_000)).toBe("4,000 m²");
    expect(fmtRatio(0.5)).toBe("0.5");
    expect(fmtRatio(1.75)).toBe("1.75");
    expect(fmtRatio(2)).toBe("2");
  });
});

describe("planning attribution", () => {
  test("credits zoning and heritage datasets, with their own licences, only when rendered", () => {
    render(
      <SourcesLine
        censusYear={2021} hasCensus={false} hasPrice={false} hasAmenities={false} hasSchoolSectors={false}
        hasFederal={false} hasStateMember={false} stateName="Tasmania"
        planningSources={planningCreditIds(planning({
          zoneShares: [{ family: "rural", sharePct: 80 }],
          zoningSource: "tas_kingborough_ips_2015+tas_tps_zones",
          heritageSource: "tas_tps_local_historic_heritage_code",
        }))}
      />,
    );
    expect(screen.getByText(/Tasmanian Planning Scheme Zones, theLIST © State of Tasmania \(CC BY 3\.0 AU\)/)).toBeInTheDocument();
    expect(screen.getByText(/Kingborough Interim Planning Scheme 2015 Zones/)).toBeInTheDocument();
    // heritage had no rendered value, so it is not credited
    expect(screen.queryByText(/Local Historic Heritage/)).not.toBeInTheDocument();
  });

  test("credits the NSW development-standard maps whenever the card shows or discusses them", () => {
    render(
      <SourcesLine
        censusYear={2021} hasCensus={false} hasPrice={false} hasAmenities={false} hasSchoolSectors={false}
        hasFederal={false} hasStateMember={false} stateName="New South Wales"
        planningSources={planningCreditIds(nsw)}
      />,
    );
    expect(screen.getByText(/Land Zoning, NSW Department of Planning \(CC BY\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/Height of Buildings, Floor Space Ratio and Minimum Lot Size, NSW Department of Planning \(CC BY\)/),
    ).toBeInTheDocument();
    // Withheld-only still credits it: the card states a mapped share from it.
    expect(planningCreditIds(planning({
      zoneShares: [{ family: "res_low", sharePct: 99 }], zoningCoveragePct: 99, zoningSource: "nsw_epi_land_zoning",
      nswFsrMappedPct: 4.9,
    }))).toEqual(["nsw_epi_land_zoning", "nsw_epi_development_standards"]);
    // A partial-coverage note credits the zoning layer it measured.
    expect(planningCreditIds(planning({ zoningCoveragePct: 2.9, zoningSource: "nsw_epi_land_zoning" }))).toEqual([
      "nsw_epi_land_zoning",
    ]);
  });

  test("credits nothing for a suburb without a planning block", () => {
    expect(planningCreditIds(undefined)).toEqual([]);
    expect(planningCreditIds(planning({ zoningCoveragePct: 0, zoningSource: "nsw_epi_land_zoning" }))).toEqual([]);
  });
});
