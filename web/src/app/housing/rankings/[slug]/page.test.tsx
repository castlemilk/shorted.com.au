import { render, screen, within } from "@testing-library/react";

import HousingRankingPage, { generateStaticParams } from "./page";
import {
  HOUSING_RANKING_SLUGS,
  getHousingRanking,
} from "~/@/lib/housing-rankings/registry";
import { siteConfig } from "~/@/config/site";

const getHousingRankingData = jest.fn();
const bailOnEmptyRender = jest.fn();
const itemListStructuredData = jest.fn();
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  ItemListStructuredData: (props: unknown) => {
    itemListStructuredData(props);
    return null;
  },
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getHousingRankingData", () => ({
  getHousingRankingData: (...args: unknown[]) => getHousingRankingData(...args),
}));

const SUBURBS = [
  {
    salCode: "10002",
    salName: "BETA HEIGHTS",
    stateCode: "NSW",
    postcode: "2001",
    latestMedianPrice: 650_000,
    yoyPct: -1.24,
    population: 3_200,
    medianWeeklyHhdIncome: 1_850,
  },
  {
    salCode: "10001",
    salName: "ALPHA",
    stateCode: "NSW",
    postcode: "2000",
    latestMedianPrice: 450_000,
    yoyPct: 3.24,
    population: 5_000,
    medianWeeklyHhdIncome: 2_100,
  },
  {
    salCode: "10003",
    salName: "GAMMA-BY-SEA",
    stateCode: "NSW",
    postcode: "2002",
    latestMedianPrice: 725_500,
    yoyPct: 0,
    population: 900,
    medianWeeklyHhdIncome: 1_600,
  },
];

const params = (slug: string) => Promise.resolve({ slug });

describe("HousingRankingPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getHousingRankingData.mockResolvedValue({
      asOfDate: "2026-06-30",
      suburbs: SUBURBS,
    });
  });

  it("prerenders every published registry slug", () => {
    expect(generateStaticParams()).toEqual(
      HOUSING_RANKING_SLUGS.map((slug) => ({ slug })),
    );
    // 5 metrics x the states with a priced feed (NSW/VIC/SA as at 2026-08-25).
    expect(HOUSING_RANKING_SLUGS).toHaveLength(15);
  });

  it("404s an unknown slug before fetching data", async () => {
    await expect(
      HousingRankingPage({ params: params("not-a-ranking") }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    expect(getHousingRankingData).not.toHaveBeenCalled();
  });

  it("renders ranked rows, top-three tiles, editorial copy and required links", async () => {
    const ranking = getHousingRanking("cheapest-suburbs-nsw")!;
    render(
      await HousingRankingPage({
        params: params(ranking.slug),
      }),
    );

    expect(getHousingRankingData).toHaveBeenCalledWith("NSW");
    expect(
      screen.getByRole("heading", { level: 1, name: ranking.h1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(ranking.dek)).toBeInTheDocument();
    expect(screen.getByText(ranking.blurb)).toBeInTheDocument();

    const leaders = within(screen.getByLabelText(`${ranking.h1} top three`));
    expect(leaders.getByText("1")).toBeInTheDocument();
    expect(leaders.getByText("Alpha")).toBeInTheDocument();
    expect(leaders.getByText("$450,000")).toBeInTheDocument();

    const table = within(screen.getByRole("table", { name: ranking.h1 }));
    const names = table
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getByRole("rowheader").textContent);
    expect(names).toEqual(["Alpha", "Beta Heights", "Gamma-By-Sea"]);
    expect(table.getByText("+3.2%")).toBeInTheDocument();
    expect(table.getByText("-1.2%")).toBeInTheDocument();
    expect(table.getByText("$2,100")).toBeInTheDocument();

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/housing/nsw/alpha-2000?sal=10001");
    for (const related of ranking.related) {
      expect(hrefs).toContain(`/housing/rankings/${related}`);
    }
    expect(hrefs).toContain("/housing/rankings/cheapest-suburbs-vic");
    expect(hrefs).toContain("/housing/nsw");
    expect(hrefs).toContain("/price-drops");
    expect(itemListStructuredData).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: "Place",
        items: expect.arrayContaining([
          expect.objectContaining({
            url: `${siteConfig.url}/housing/nsw/alpha-2000?sal=10001`,
          }),
        ]),
      }),
    );
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("renders an uncached fallback without throwing when no rows are available", async () => {
    getHousingRankingData.mockResolvedValue(null);

    const page = await HousingRankingPage({
      params: params("cheapest-suburbs-nsw"),
    });
    expect(() => render(page)).not.toThrow();
    expect(
      screen.getByText(/Housing ranking data is temporarily unavailable/),
    ).toBeInTheDocument();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("shows the price-to-income metric for affordability rows beyond the top three", async () => {
    getHousingRankingData.mockResolvedValue({
      asOfDate: "2026-06-30",
      suburbs: [
        ...SUBURBS,
        {
          salCode: "10004",
          salName: "DELTA",
          stateCode: "NSW",
          postcode: "2003",
          latestMedianPrice: 500_000,
          yoyPct: 1,
          population: 2_500,
          medianWeeklyHhdIncome: 1_000,
        },
      ],
    });

    const ranking = getHousingRanking("most-affordable-suburbs-nsw")!;
    render(await HousingRankingPage({ params: params(ranking.slug) }));

    const table = within(screen.getByRole("table", { name: ranking.h1 }));
    expect(
      table.getByRole("columnheader", { name: "Price / income" }),
    ).toBeInTheDocument();
    const deltaRow = table.getByRole("row", { name: /Delta/ });
    expect(within(deltaRow).getByText("9.6×")).toBeInTheDocument();
  });
});
