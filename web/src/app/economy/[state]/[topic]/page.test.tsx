import { render, screen } from "@testing-library/react";

import EconomyTopicPage, { generateStaticParams } from "./page";
import {
  ECONOMY_TOPICS,
  PUBLISHED_ECONOMY_TOPIC_PAIRS,
} from "~/@/lib/economy/topics";

const getEconomyTopicSnapshot = jest.fn();
const listStateCompanies = jest.fn();
const bailOnEmptyRender = jest.fn();
const chartProps = jest.fn();
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
  BreadcrumbStructuredData: () => null,
}));
jest.mock("~/@/components/seo/llm-meta", () => ({
  LLMMeta: () => null,
}));
jest.mock("~/@/components/economy/economy-charts", () => ({
  EconomySeriesChartView: (props: {
    points: { date: string; value: number }[];
    ariaLabel: string;
    seriesKey: string;
    format: string;
  }) => {
    chartProps(props);
    return (
      <div
        role="img"
        aria-label={props.ariaLabel}
        data-first-date={props.points[0]?.date}
      />
    );
  },
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getEconomyTopic", () => ({
  getEconomyTopicSnapshot: (...args: unknown[]) =>
    getEconomyTopicSnapshot(...args),
}));
jest.mock("~/app/actions/getEconomy", () => ({
  listStateCompanies: (...args: unknown[]) => listStateCompanies(...args),
}));

const snapshot = {
  state: "wa",
  topic: "wages",
  series: [
    {
      seriesKey: "wages.wage_price_index.wa",
      topic: "wages",
      metric: "wage_price_index",
      product: "total",
      regionType: "state",
      regionCode: "wa",
      regionName: "Western Australia",
      unit: "index",
      frequency: "quarterly",
      adjustment: "seasadj",
      sourceKey: "ABS Wage Price Index",
      sourceLicence: "Creative Commons Attribution 4.0",
      latestPeriod: "2025-04-01",
      observations: [
        { period: "2025-01-01", value: 100 },
        { period: "2025-04-01", value: 102 },
      ],
    },
    {
      seriesKey: "wages.wpi_yoy.wa",
      topic: "wages",
      metric: "wpi_yoy",
      product: "total",
      regionType: "state",
      regionCode: "wa",
      regionName: "Western Australia",
      unit: "percent",
      frequency: "quarterly",
      adjustment: "original",
      sourceKey: "ABS Wage Price Index",
      sourceLicence: "Creative Commons Attribution 4.0",
      latestPeriod: "2025-04-01",
      observations: [
        { period: "2025-01-01", value: 3.1 },
        { period: "2025-04-01", value: 3.3 },
      ],
    },
  ],
};

const companies = {
  companies: [
    {
      stockCode: "BHP",
      companyName: "BHP Group",
      industry: "Materials",
      weight: 0.62,
      basis: "Pilbara iron ore and Western Australian nickel operations",
      marketCap: 200_000_000_000,
      shortPercent: 1.2,
      logoUrl: "",
      source: "llm",
    },
    {
      stockCode: "RIO",
      companyName: "Rio Tinto",
      industry: "Materials",
      weight: 0.34,
      basis: "Pilbara mines and port infrastructure",
      marketCap: 150_000_000_000,
      shortPercent: 0.8,
      logoUrl: "",
      source: "llm",
    },
    {
      stockCode: "HQX",
      companyName: "Head Office Only",
      industry: "Industrials",
      weight: 1,
      basis: "Perth headquarters",
      marketCap: 1_000_000,
      shortPercent: 0,
      logoUrl: "",
      source: "hq_fallback",
    },
    {
      stockCode: "NOB",
      companyName: "No Basis Limited",
      industry: "Industrials",
      weight: 0.2,
      basis: "",
      marketCap: 1_000_000,
      shortPercent: 0,
      logoUrl: "",
      source: "llm",
    },
  ],
};

const params = (state: string, topic: string) =>
  Promise.resolve({ state, topic });

describe("EconomyTopicPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getEconomyTopicSnapshot.mockResolvedValue(snapshot);
    listStateCompanies.mockResolvedValue(companies);
  });

  it("prerenders exactly the registry's published state-topic pairs", () => {
    expect(generateStaticParams()).toEqual(PUBLISHED_ECONOMY_TOPIC_PAIRS);
  });

  it("404s an unpublished or unknown pair before fetching", async () => {
    await expect(
      EconomyTopicPage({ params: params("act", "labour") }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getEconomyTopicSnapshot).not.toHaveBeenCalled();
    expect(listStateCompanies).not.toHaveBeenCalled();
  });

  it("renders every resolved series, attribution, charts, companies and cross-links", async () => {
    render(await EconomyTopicPage({ params: params("wa", "wages") }));

    expect(getEconomyTopicSnapshot).toHaveBeenCalledWith("wa", "wages");
    expect(listStateCompanies).toHaveBeenCalledWith("wa", 8);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Western Australia wage growth",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(ECONOMY_TOPICS.wages.ledes.wa!)).toBeInTheDocument();
    expect(screen.getByText(ECONOMY_TOPICS.wages.explainer)).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { level: 2, name: "Wage price index" }),
    ).toBeInTheDocument();
    expect(screen.getByText("102.0")).toBeInTheDocument();
    expect(screen.getByText("+2.0")).toBeInTheDocument();
    expect(screen.getAllByText("Quarterly").length).toBeGreaterThan(0);
    expect(screen.getByText("Seasonally adjusted")).toBeInTheDocument();
    expect(screen.getAllByText("ABS Wage Price Index").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Creative Commons Attribution 4.0").length,
    ).toBeGreaterThan(0);

    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(chartProps).toHaveBeenCalledWith(
      expect.objectContaining({
        points: [
          { date: "2025-01-01", value: 100 },
          { date: "2025-04-01", value: 102 },
        ],
        format: "index",
      }),
    );

    expect(screen.getByRole("link", { name: /BHP/ })).toHaveAttribute(
      "href",
      "/shorts/BHP",
    );
    expect(screen.getByRole("link", { name: /Rio Tinto/ })).toHaveAttribute(
      "href",
      "/shorts/RIO",
    );
    expect(screen.getByText("Majority of operations (estimate)")).toBeInTheDocument();
    expect(
      screen.getByText("Significant operations exposure (estimate)"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Head Office Only")).not.toBeInTheDocument();
    expect(screen.queryByText("No Basis Limited")).not.toBeInTheDocument();

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/economy/wa");
    expect(hrefs).toContain("/economy/nsw/wages");
    expect(hrefs).toContain("/economy/wa/approvals");
    expect(hrefs).not.toContain("/economy/wa/wages");
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("renders an uncached fallback without throwing when the snapshot is empty", async () => {
    getEconomyTopicSnapshot.mockResolvedValue(null);
    listStateCompanies.mockResolvedValue({ companies: [] });

    const page = await EconomyTopicPage({ params: params("wa", "wages") });
    expect(() => render(page)).not.toThrow();
    expect(
      screen.getByText(/Economic series are temporarily unavailable/),
    ).toBeInTheDocument();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });
});
