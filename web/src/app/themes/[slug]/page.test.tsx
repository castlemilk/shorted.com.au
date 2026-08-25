import { render, screen, within } from "@testing-library/react";

import ThemePage, { generateStaticParams } from "./page";
import { THEME_SLUGS, getTheme } from "~/@/lib/themes/registry";

const getThemeSnapshot = jest.fn();
const getStockHeadlines = jest.fn();
const bailOnEmptyRender = jest.fn();
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
  DatasetStructuredData: () => null,
  ItemListStructuredData: ({ items }: { items: unknown[] }) => (
    <div data-testid="itemlist">{items.length}</div>
  ),
}));
// The chart is a dynamic(ssr:false) client chunk — stub the loader module so
// the server page test never pulls visx or a browser measurement in.
jest.mock("~/@/components/themes/theme-charts", () => ({
  ThemeShortInterestChart: ({ points }: { points: unknown[] }) => (
    <div data-testid="theme-chart">{points.length}</div>
  ),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getThemeData", () => ({
  getThemeSnapshot: (...args: unknown[]) => getThemeSnapshot(...args),
}));
jest.mock("~/app/actions/getStockNews", () => ({
  getStockHeadlines: (...args: unknown[]) => getStockHeadlines(...args),
}));

function row(code: string, shortPct: number, change4w: number) {
  return {
    code,
    name: `${code} Limited`,
    industry: "Materials",
    shortPct,
    shortPctChange4w: change4w,
    latestPrice: 12.34,
    priceChange1m: -3.2,
    daysToCover: 4.5,
  };
}

const ROWS = [row("PLS", 18.42, 1.31), row("MIN", 9.87, -0.44), row("LTR", 4.01, 0.9)];

const SNAPSHOT = {
  asOfDate: "2026-08-18",
  rows: ROWS,
  stats: {
    constituents: 3,
    medianShortPct: 9.87,
    mostShorted: { code: "PLS", name: "PLS Limited", shortPct: 18.42 },
    biggestRiser: { code: "PLS", name: "PLS Limited", changePp: 1.31 },
    aboveFivePct: 2,
  },
  series: [
    { date: "2026-07-06", avg: 9.1, min: 3.2, max: 17.5, count: 3 },
    { date: "2026-07-13", avg: 9.6, min: 3.4, max: 18.0, count: 3 },
    { date: "2026-07-20", avg: 10.2, min: 3.9, max: 18.4, count: 3 },
  ],
};

const params = (slug: string) => Promise.resolve({ slug });

describe("ThemePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getThemeSnapshot.mockResolvedValue(SNAPSHOT);
    getStockHeadlines.mockResolvedValue([]);
  });

  it("prerenders every registry slug", () => {
    expect(generateStaticParams()).toEqual(
      THEME_SLUGS.map((slug) => ({ slug })),
    );
    expect(THEME_SLUGS).toHaveLength(10);
  });

  it("404s an unknown slug", async () => {
    await expect(ThemePage({ params: params("not-a-theme") })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the editorial copy, stat tiles, chart and constituent table", async () => {
    const theme = getTheme("lithium")!;
    render(await ThemePage({ params: params("lithium") }));

    // Server-rendered SEO body.
    expect(
      screen.getByRole("heading", { level: 1, name: theme.h1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(theme.dek)).toBeInTheDocument();
    expect(screen.getByText(theme.blurb)).toBeInTheDocument();

    // Stat tiles (scoped — the table repeats the same percentages).
    const tiles = within(screen.getByLabelText(`${theme.h1} summary`));
    expect(tiles.getByText("Median short")).toBeInTheDocument();
    expect(tiles.getByText("9.87%")).toBeInTheDocument();
    expect(tiles.getByText("across 3 constituents")).toBeInTheDocument();
    expect(tiles.getByText("Most shorted")).toBeInTheDocument();
    expect(tiles.getByText("18.42% of issued capital")).toBeInTheDocument();
    expect(tiles.getByText("Biggest 4-week riser")).toBeInTheDocument();
    expect(tiles.getByText("+1.31pp in 4 weeks")).toBeInTheDocument();
    expect(tiles.getByText("Above 5% short")).toBeInTheDocument();
    expect(tiles.getByText("2")).toBeInTheDocument();

    // Chart gets the aggregated series, not raw constituents.
    expect(screen.getByTestId("theme-chart")).toHaveTextContent("3");

    // Constituent table, each row linking to the stock page.
    const links = screen
      .getAllByRole("link")
      .map((el) => el.getAttribute("href"));
    for (const r of ROWS) {
      expect(screen.getByText(`${r.code} Limited`)).toBeInTheDocument();
      expect(links).toContain(`/shorts/${r.code}`);
    }

    // Cross-links: related themes + related industries.
    for (const relSlug of theme.relatedThemes) {
      expect(links).toContain(`/themes/${relSlug}`);
    }
    expect(links).toContain("/industry/materials");

    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("merges member headlines into one newest-first strip", async () => {
    getStockHeadlines.mockImplementation(async (code: string) =>
      code === "MIN"
        ? [
            {
              id: "b",
              headline: "MIN headline",
              url: "https://example.com/b",
              source: "AFR",
              publishedAtIso: "2026-08-20T00:00:00.000Z",
            },
          ]
        : code === "PLS"
          ? [
              {
                id: "a",
                headline: "PLS headline",
                url: "https://example.com/a",
                source: "Reuters",
                publishedAtIso: "2026-08-21T00:00:00.000Z",
              },
            ]
          : [],
    );

    render(await ThemePage({ params: params("lithium") }));

    const headlines = screen
      .getAllByRole("link")
      .map((el) => el.textContent)
      .filter((text) => text?.endsWith("headline"));
    expect(headlines).toEqual(["PLS headline", "MIN headline"]);
  });

  it("drops the chart but keeps the page when the series aggregate is empty", async () => {
    getThemeSnapshot.mockResolvedValue({ ...SNAPSHOT, series: [] });

    render(await ThemePage({ params: params("lithium") }));

    expect(screen.queryByTestId("theme-chart")).not.toBeInTheDocument();
    expect(screen.getByText("PLS Limited")).toBeInTheDocument();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("renders the copy-only shell and bails the render when the snapshot fails", async () => {
    getThemeSnapshot.mockResolvedValue(null);
    const theme = getTheme("lithium")!;

    render(await ThemePage({ params: params("lithium") }));

    expect(
      screen.getByRole("heading", { level: 1, name: theme.h1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(theme.blurb)).toBeInTheDocument();
    expect(
      screen.getByText(/Theme data is temporarily unavailable/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("theme-chart")).not.toBeInTheDocument();
    // No news fan-out when there are no rows to fan out over.
    expect(getStockHeadlines).not.toHaveBeenCalled();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  // A single sick constituent must never take the route down — the failed
  // member simply drops out of the strip.
  it("survives a constituent whose news read fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    getStockHeadlines.mockImplementation(async (code: string) => {
      if (code === "PLS") throw new Error("news backend down");
      return [
        {
          id: code,
          headline: `${code} headline`,
          url: `https://example.com/${code}`,
          source: "AFR",
          publishedAtIso: "2026-08-20T00:00:00.000Z",
        },
      ];
    });

    render(await ThemePage({ params: params("lithium") }));

    expect(screen.getByText("MIN headline")).toBeInTheDocument();
    expect(screen.getByText("LTR headline")).toBeInTheDocument();
    expect(screen.queryByText("PLS headline")).not.toBeInTheDocument();
    // The table is untouched — the failure is scoped to the news strip.
    expect(screen.getByText("PLS Limited")).toBeInTheDocument();
    warn.mockRestore();
  });
});
