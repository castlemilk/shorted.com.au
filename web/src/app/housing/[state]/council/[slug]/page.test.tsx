import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { render, screen, within } from "@testing-library/react";

import {
  CouncilDropSuburbSchema,
  CouncilPriceDropsSchema,
  CouncilProfileSchema,
  CouncilRollupSchema,
  CouncilSeriesPointSchema,
  CouncilSeriesSchema,
  CouncilSuburbSchema,
  CouncilSummarySchema,
  GetCouncilProfileResponseSchema,
  LgaInfoSchema,
} from "~/gen/shorts/v1alpha1/housing_pb";

import { NotFoundError } from "~/app/actions/withRetry";
import CouncilPage, { generateMetadata, generateStaticParams } from "./page";

const getCouncilProfile = jest.fn();
const listCouncils = jest.fn();
const bailOnEmptyRender = jest.fn();
const hubMap = jest.fn((_props: unknown) => <div data-testid="hub-map" />);
const seriesChart = jest.fn((_props: unknown) => <div data-testid="series-chart" />);
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

const permanentRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
  permanentRedirect: (url: string) => permanentRedirect(url),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({ Breadcrumbs: () => null }));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({ BreadcrumbListSchema: () => null }));
jest.mock("~/@/components/housing/council/council-client", () => ({
  CouncilHubMap: (props: unknown) => hubMap(props),
  CouncilSeriesChart: (props: unknown) => seriesChart(props),
}));
jest.mock("~/app/actions/config", () => ({ bailOnEmptyRender: () => bailOnEmptyRender() }));
jest.mock("~/app/actions/withRetry", () => ({ NotFoundError: class NotFoundError extends Error {} }));
jest.mock("~/app/actions/getHousing", () => ({
  getCouncilProfile: (...args: unknown[]) => getCouncilProfile(...args),
  listCouncils: (...args: unknown[]) => listCouncils(...args),
}));

const pt = (period: string, periodLabel: string, value: number) =>
  create(CouncilSeriesPointSchema, { period, periodLabel, value });

function profile(overrides: Partial<Parameters<typeof create<typeof CouncilProfileSchema>>[1]> = {}) {
  return create(GetCouncilProfileResponseSchema, {
    profile: create(CouncilProfileSchema, {
      lgaVintage: "ABS ASGS Edition 3, LGA 2024 boundaries",
      factsAsOf: "2026-09-20",
      council: create(LgaInfoSchema, {
        lgaCode: "11570", lgaName: "Canterbury-Bankstown", displayName: "Canterbury-Bankstown", stateCode: "NSW",
        kind: "council", slug: "canterbury-bankstown", population: 389_687, erpYear: 2025, areaSqkm: 110.2,
        website: "https://www.cbcity.nsw.gov.au/", wikidataQid: "Q24070750", medianAge: 35,
        seifaIrsadDecile: 3, fedFagAud: 13_757_751, fedFagYear: "2025-26",
      }),
      summary: create(CouncilSummarySchema, {
        lgaCode: "11570", slug: "canterbury-bankstown", displayName: "Canterbury-Bankstown", kind: "council",
        stateCode: "NSW", population: 389_687, erpYear: 2025, popGrowthPct: 1.05, areaSqkm: 110.2,
        densityPerSqkm: 3536.2, memberSuburbCount: 38, councilHouseMedian: 1_399_999,
        councilHouseMedianPeriod: "2023-24", dataThrough: "2026-07-31",
      }),
      series: [
        create(CouncilSeriesSchema, {
          measure: "erp", unit: "persons", frequency: "annual", source: "abs_erp_lga", sourceLicence: "CC-BY-4.0",
          points: [pt("2024-06-30", "2024", 385_000), pt("2025-06-30", "2025", 389_687)],
        }),
        create(CouncilSeriesSchema, {
          measure: "house_median_price", unit: "AUD", frequency: "fy", source: "abs_regional_lga", sourceLicence: "CC-BY-4.0",
          points: [pt("2023-06-30", "2022-23", 1_300_000), pt("2024-06-30", "2023-24", 1_399_999)],
        }),
      ],
      suburbs: [
        create(CouncilSuburbSchema, {
          salCode: "12166", salName: "Kingsgrove", postcode: "2208", population: 14_000, share: 0.491, dominant: false,
          vgMedian: 1_900_000, vgMedianPeriod: "2026-06-30", bushfireSharePct: 0,
        }),
        create(CouncilSuburbSchema, { salCode: "10001", salName: "Bankstown", postcode: "2200", population: 34_000, share: 1, dominant: true }),
      ],
      rollup: create(CouncilRollupSchema, { memberSuburbs: 2, dominantSuburbs: 1, bushfireSharePct: 5.2, bushfireCoveredSuburbs: 41 }),
      ...overrides,
    }),
  });
}

const params = (state: string, slug: string) => ({ params: Promise.resolve({ state, slug }) });

beforeEach(() => {
  jest.clearAllMocks();
  getCouncilProfile.mockResolvedValue(profile());
});

describe("council page", () => {
  it("resolves the council from the path, never from search params", () => {
    const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
    expect(source).not.toContain("searchParams");
    expect(source).not.toContain("shorts_pb");
  });

  it("renders identity, ERP wording, a dated council-wide median and the sources", async () => {
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    expect(getCouncilProfile).toHaveBeenCalledWith("NSW", "canterbury-bankstown");
    expect(screen.getByRole("heading", { level: 1, name: "Canterbury-Bankstown" })).toBeInTheDocument();
    // Both the banner and the population tile name the measure and its date.
    expect(screen.getByRole("banner")).toHaveTextContent("ABS estimated resident population, 30 June 2025");
    const tiles = within(screen.getByRole("region", { name: "Key facts" }));
    expect(tiles.getByRole("heading", { name: "Population" }).parentElement!).toHaveTextContent("ABS estimated resident population, 30 June 2025");
    const tile = screen.getByText("Council-wide house median").parentElement!;
    expect(tile).toHaveTextContent("FY 2023-24");
    expect(screen.getByRole("banner")).toHaveTextContent(/Council series run to Jul(y)? 2026\./);
    // No blanket claim that every figure is dated: not every source is.
    expect(screen.queryByText(/Every figure below carries its own date/)).toBeNull();
    expect(screen.getByText(/Wikidata \(CC0\)/)).toBeInTheDocument();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("passes only serializable props (format keys, codes) to the client charts and map", async () => {
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    for (const call of [...seriesChart.mock.calls, ...hubMap.mock.calls]) {
      expect(() => JSON.stringify(call[0])).not.toThrow();
      expect(JSON.stringify(call[0])).not.toMatch(/function/);
      for (const v of Object.values(call[0] as Record<string, unknown>)) expect(typeof v).not.toBe("function");
    }
    expect(seriesChart.mock.calls.map((c) => (c[0] as { format: string }).format)).toEqual(["count", "aud"]);
    expect(hubMap).toHaveBeenCalledTimes(1);
  });

  it("never shows a missing suburb median as a number, and keeps a measured 0% bushfire share", async () => {
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    const table = screen.getByRole("table");
    const bankstown = within(table).getByRole("link", { name: "Bankstown" }).closest("tr")!;
    expect(bankstown).not.toHaveTextContent("$");
    expect(bankstown).not.toHaveTextContent(/\b0%/);
    const kingsgrove = within(table).getByRole("link", { name: "Kingsgrove" }).closest("tr")!;
    expect(kingsgrove).toHaveTextContent("49%");
    expect(kingsgrove).toHaveTextContent("$1.9M");
    expect(kingsgrove).toHaveTextContent("– / 0%");
  });

  it("omits facts no source covers rather than printing zeros", async () => {
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    expect(screen.queryByText("Federal grants per resident")).toBeNull(); // no fagPerResident on the summary
    expect(screen.queryByText("Dwelling approvals")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Asking-price cuts" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Representation" })).toBeNull();
    expect(screen.queryByText(/Flood planning land/)).toBeNull();
  });

  it("shows the price-drops pulse only when the aggregate is present, dated", async () => {
    getCouncilProfile.mockResolvedValue(profile({
      priceDrops: create(CouncilPriceDropsSchema, {
        droppedListingCount: 7, trackedListingCount: 100, droppedShare: 0.07, suburbsTracked: 3, medianDropPct: 0.04,
        // 2026-09-24T01:00Z and 2026-09-23T20:00Z
        asOf: { seconds: BigInt(1790211600), nanos: 0 } as never,
        dataThrough: { seconds: BigInt(1790193600), nanos: 0 } as never,
        suburbs: [create(CouncilDropSuburbSchema, { salCode: "10001", salName: "BANKSTOWN", postcode: "2200", droppedListingCount: 3, trackedListingCount: 40 })],
      }),
    }));
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    const section = screen.getByRole("heading", { name: "Asking-price cuts" }).closest("section")!;
    expect(screen.getByText("7.0%")).toBeInTheDocument();
    expect(section).toHaveTextContent(/Computed 24 Sept? 2026; newest crawl observation 24 Sept? 2026\./);
    expect(section).toHaveTextContent("seen in the last 14 days");
    expect(section).toHaveTextContent("median over every cut listing");
    expect(section).not.toHaveTextContent("median of suburb medians");
  });

  describe("price-drops staleness (the /price-drops 72h rule)", () => {
    // 2026-09-24T01:00Z and 2026-09-23T20:00Z, as above.
    const drops = () => create(CouncilPriceDropsSchema, {
      droppedListingCount: 7, trackedListingCount: 100, droppedShare: 0.07, suburbsTracked: 3,
      asOf: { seconds: BigInt(1790211600), nanos: 0 } as never,
      dataThrough: { seconds: BigInt(1790193600), nanos: 0 } as never,
    });
    afterEach(() => jest.useRealTimers());

    it("warns once the crawl data behind the block is more than three days old", async () => {
      jest.useFakeTimers({ now: new Date("2026-09-28T00:00:00Z"), doNotFake: ["nextTick", "setImmediate"] });
      getCouncilProfile.mockResolvedValue(profile({ priceDrops: drops() }));
      render(await CouncilPage(params("nsw", "canterbury-bankstown")));
      const section = screen.getByRole("heading", { name: "Asking-price cuts" }).closest("section")!;
      // Dated by the shared formatter: a fixed "Sep", never ICU's "Sept".
      expect(section).toHaveTextContent("Computed 24 Sep 2026; newest crawl observation 24 Sep 2026.");
      expect(within(section).getByTestId("council-drops-stale")).toHaveTextContent(
        /not been updated for more than three days.*in this section runs to 24 Sep 2026, not to today/,
      );
    });

    it("says nothing while the data is inside the window", async () => {
      jest.useFakeTimers({ now: new Date("2026-09-25T00:00:00Z"), doNotFake: ["nextTick", "setImmediate"] });
      getCouncilProfile.mockResolvedValue(profile({ priceDrops: drops() }));
      render(await CouncilPage(params("nsw", "canterbury-bankstown")));
      expect(screen.getByRole("heading", { name: "Asking-price cuts" })).toBeInTheDocument();
      expect(screen.queryByTestId("council-drops-stale")).toBeNull();
    });
  });

  it("shows Victorian council finances with their year, and credits LGPRF only then", async () => {
    const vic = profile();
    Object.assign(vic.profile!.council!, { avgRates: 2_150, opSurplusRatio: -3.25, assetRenewalRatio: 96, finSource: "vic_lgprf", finYear: "2024-25" });
    getCouncilProfile.mockResolvedValue(vic);
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    const finances = screen.getByRole("heading", { name: "Council finances" }).closest("section")!;
    expect(finances).toHaveTextContent("$2,150");
    expect(finances).toHaveTextContent("-3.3%");
    expect(finances).toHaveTextContent("2024-25");
    expect(screen.getByText(/Financials: Local Government Victoria \(LGPRF\), 2024-25/)).toBeInTheDocument();
  });

  it("does not credit LGPRF when no finances are shown", async () => {
    const vic = profile();
    Object.assign(vic.profile!.council!, { avgRates: 0, finSource: "vic_lgprf" });
    getCouncilProfile.mockResolvedValue(vic);
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    expect(screen.queryByRole("heading", { name: "Council finances" })).toBeNull();
    expect(screen.queryByText(/LGPRF/)).toBeNull();
    expect(screen.queryByText(/Local Government Victoria/)).toBeNull();
  });

  it("redirects a non-canonical slug to the council's own URL", async () => {
    await expect(CouncilPage(params("nsw", "Canterbury-Bankstown"))).rejects.toThrow(
      "NEXT_REDIRECT:/housing/nsw/council/canterbury-bankstown",
    );
  });

  it("does not let ISR pin a hub whose member suburbs failed to load", async () => {
    getCouncilProfile.mockResolvedValue(profile({ suburbs: [] }));
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("says how much of the council a hazard share rests on", async () => {
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    expect(screen.getByText(/Over 41 of 2 member suburbs/)).toBeInTheDocument();
  });

  it("scopes neighbours to the state in the copy", async () => {
    getCouncilProfile.mockResolvedValue(profile({
      neighbours: [{ lgaCode: "12930", slug: "georges-river", displayName: "Georges River", kind: "council", stateCode: "NSW", sharesBorder: true, sharedSuburbs: 0 } as never],
    }));
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    expect(screen.getByRole("heading", { name: "Neighbouring councils" }).closest("section")!).toHaveTextContent("in the same state");
  });

  it("explains that no council governs an unincorporated area, and that the ACT is the ACT Government's", async () => {
    const act = profile();
    act.profile!.summary!.kind = "unincorporated";
    act.profile!.summary!.displayName = "Unincorporated ACT";
    act.profile!.summary!.slug = "unincorporated-act";
    getCouncilProfile.mockResolvedValue(act);
    const { container: actPage } = render(await CouncilPage(params("act", "unincorporated-act")));
    expect(screen.getByRole("note")).toHaveTextContent(/ACT has no local councils/);
    expect(screen.getByRole("note")).toHaveTextContent(/ACT Government/);
    // No council map exists for the ACT: never point at one.
    expect(actPage.querySelector('a[href*="level=council"]')).toBeNull();
    expect(actPage).not.toHaveTextContent(/every Australian Capital Territory council/);

    const nsw = profile();
    nsw.profile!.summary!.kind = "unincorporated";
    nsw.profile!.summary!.displayName = "Unincorporated NSW";
    nsw.profile!.summary!.slug = "unincorporated-nsw";
    getCouncilProfile.mockResolvedValue(nsw);
    render(await CouncilPage(params("nsw", "unincorporated-nsw")));
    expect(screen.getAllByRole("note")[1]).toHaveTextContent(/No council governs Unincorporated NSW/);
  });

  it("404s an unknown state or slug, and bails out of ISR on a transient failure", async () => {
    await expect(CouncilPage(params("atlantis", "x"))).rejects.toThrow("NEXT_NOT_FOUND");
    getCouncilProfile.mockRejectedValueOnce(new NotFoundError("council not found"));
    await expect(CouncilPage(params("nsw", "nowhere"))).rejects.toThrow("NEXT_NOT_FOUND");
    getCouncilProfile.mockResolvedValueOnce(undefined);
    render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("metadata is canonical and JSON-LD names the area, the organisation and Wikidata", async () => {
    const meta = await generateMetadata(params("nsw", "canterbury-bankstown"));
    expect(meta.alternates?.canonical).toBe("https://shorted.com.au/housing/nsw/council/canterbury-bankstown");
    const { container } = render(await CouncilPage(params("nsw", "canterbury-bankstown")));
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.innerHTML);
    const types = ld["@graph"].map((n: { "@type": string }) => n["@type"]);
    expect(types).toEqual(["AdministrativeArea", "GovernmentOrganization"]);
    expect(ld["@graph"][0].sameAs).toEqual(["https://www.wikidata.org/wiki/Q24070750"]);
  });

  it("generateStaticParams lists every council in every state", async () => {
    listCouncils.mockImplementation(async (st: string) =>
      st === "NSW" ? { councils: [{ slug: "albury" }, { slug: "yass-valley" }] } : st === "ACT" ? { councils: [{ slug: "unincorporated-act" }] } : undefined);
    await expect(generateStaticParams()).resolves.toEqual([
      { state: "nsw", slug: "albury" }, { state: "nsw", slug: "yass-valley" }, { state: "act", slug: "unincorporated-act" },
    ]);
  });
});
