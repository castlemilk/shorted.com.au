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
import { SuburbProfile, SourcesLine, planningCreditIds } from "./suburb-profile";
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

const nsw = planning({
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
  instruments: ["Ku-ring-gai Local Environmental Plan 2015"],
  zoningSource: "nsw_epi_land_zoning",
  heritageSource: "nsw_epi_heritage",
  sourceLicence: "CC-BY-4.0",
});

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
    expect(screen.getByText(/Source: NSW EPI Land Zoning; NSW EPI Heritage/)).toBeInTheDocument();
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

  test("credits nothing for a suburb without a planning block", () => {
    expect(planningCreditIds(undefined)).toEqual([]);
    expect(planningCreditIds(planning({ zoningCoveragePct: 0, zoningSource: "nsw_epi_land_zoning" }))).toEqual([]);
  });
});
