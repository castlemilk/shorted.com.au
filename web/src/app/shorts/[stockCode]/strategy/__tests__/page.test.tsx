/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

const mockFit = jest.fn();
const mockStrategies = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({});
const mockBreadcrumbs = jest.fn();
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
jest.mock(
  "next/dynamic",
  () =>
    () =>
    (p: {
      stockCode: string;
      fits: Array<{ strategyId: string }>;
      priceFeatures: unknown;
    }) => (
      <div
        data-testid="levels-chart"
        data-code={p.stockCode}
        data-fits={p.fits?.length ?? 0}
        data-order={p.fits?.map((f) => f.strategyId).join(",")}
        data-features={p.priceFeatures ? "yes" : "no"}
      />
    ),
);
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: (fn: unknown) => fn,
}));
jest.mock("~/app/actions/getStockStrategyFit", () => ({
  getStockStrategyFit: (...a: unknown[]) => mockFit(...a),
}));
jest.mock("~/app/actions/getStrategies", () => ({
  getStrategies: (...a: unknown[]) => mockStrategies(...a),
}));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({
  stockTabMetadata: (...a: unknown[]) => mockMetadata(...a),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  BreadcrumbStructuredData: (props: unknown) => {
    mockBreadcrumbs(props);
    return null;
  },
}));
// The registry is the one source of a tab's label (the visible breadcrumb reads
// it too): spy on it and keep the real implementation.
jest.mock("~/@/lib/stocks/stock-tabs", () => {
  const actual = jest.requireActual<typeof import("~/@/lib/stocks/stock-tabs")>(
    "~/@/lib/stocks/stock-tabs",
  );
  return { ...actual, stockTabLabel: jest.fn(actual.stockTabLabel) };
});
jest.mock("~/@/components/picks/regime-banner", () => ({
  RegimeBanner: ({ regime }: { regime: { regime: string } | null }) => (
    <div data-testid="regime">{regime?.regime ?? "none"}</div>
  ),
}));

import Page, {
  generateMetadata,
  generateStaticParams,
  revalidate,
  dynamicParams,
} from "../page";
import { stockTabLabel } from "~/@/lib/stocks/stock-tabs";

const fit = {
  stockCode: "BHP",
  asOf: "2026-10-07",
  inUniverse: true,
  regime: {
    indexCode: "XJO",
    asOf: "2026-10-07",
    regime: "uptrend",
    close: 1,
    sma50: 1,
    sma200: 1,
    pctOff52wHigh: 0,
    verdict: "",
  },
  priceFeatures: {
    asOf: "2026-10-07",
    close: 42,
    sma50: null,
    sma150: null,
    sma200: null,
    sma200PriorMonth: null,
    high52w: null,
    low52w: null,
    baseHigh: null,
    baseLow: null,
    baseDepthPct: null,
    baseLengthDays: null,
    breakoutRecent: false,
    breakoutDate: null,
    rs3mPct: null,
    rs6mPct: null,
    volumeRatio50d: null,
    sessionsAvailable: 260,
  },
  fits: [
    {
      strategyId: "canslim",
      strategyName: "CAN SLIM",
      status: "watch",
      score: 41,
      rank: 18,
      totalCount: 40,
      rules: [{ ruleId: "market", status: "pass", detail: "XJO uptrend" }],
      ruleColumns: [{ id: "market", title: "Market direction" }],
    },
    {
      strategyId: "minervini-trend-template",
      strategyName: "Minervini Trend Template",
      status: "triggered",
      score: 68,
      rank: 2,
      totalCount: 90,
      rules: [{ ruleId: "stack", status: "pass", detail: "50 > 150 > 200" }],
      ruleColumns: [{ id: "stack", title: "Average stack" }],
    },
  ],
};
const strategies = {
  regime: null,
  strategies: [
    {
      id: "canslim",
      name: "CAN SLIM",
      author: "",
      tagline: "",
      descriptionParagraphs: [],
      metadata: null,
      caveats: [],
      sources: [],
      rules: [
        {
          id: "market",
          title: "Market direction",
          ruleText: "Only buy in a confirmed uptrend.",
          evaluation: "XJO above its 50 and 200-day averages.",
          core: true,
          dataSource: "index_prices",
        },
      ],
    },
  ],
};

describe("/shorts/[stockCode]/strategy", () => {
  beforeEach(() => {
    mockFit.mockReset();
    mockStrategies.mockReset();
    mockMetadata.mockClear();
    mockBreadcrumbs.mockClear();
    (stockTabLabel as jest.Mock).mockClear();
  });

  it("renders the banner, the chart, then one panel per strategy strongest first, with rule text and evidence", async () => {
    mockFit.mockResolvedValue(fit);
    mockStrategies.mockResolvedValue(strategies);
    const { container } = render(
      await Page({ params: Promise.resolve({ stockCode: "bhp" }) }),
    );
    expect(screen.getByTestId("regime")).toHaveTextContent("uptrend");
    expect(screen.getByTestId("levels-chart")).toHaveAttribute(
      "data-fits",
      "2",
    );
    const panels = screen.getAllByRole("region", {
      name: /Trend Template|CAN SLIM/,
    });
    expect(panels[0]).toHaveAccessibleName(/Minervini Trend Template/);
    const canslim = screen.getByRole("region", { name: /CAN SLIM/ });
    expect(
      within(canslim).getByRole("link", { name: "CAN SLIM" }),
    ).toHaveAttribute("href", "/picks/canslim");
    expect(
      within(canslim).getByText("Only buy in a confirmed uptrend."),
    ).toBeInTheDocument();
    expect(
      within(canslim).getByText("XJO above its 50 and 200-day averages."),
    ).toBeInTheDocument();
    expect(within(canslim).getByText("XJO uptrend")).toBeInTheDocument();
    expect(within(canslim).getByText("rank 18 of 40")).toBeInTheDocument();
    const order = Array.from(
      container.querySelectorAll("[data-testid], section[aria-labelledby]"),
    ).map(
      (n) => n.getAttribute("data-testid") ?? n.getAttribute("aria-labelledby"),
    );
    expect(order.indexOf("levels-chart")).toBeLessThan(
      order.indexOf("fit-minervini-trend-template"),
    );
  });

  it("renders the out-of-universe explanation with no chart and asks for noindex", async () => {
    mockFit.mockResolvedValue({
      ...fit,
      inUniverse: false,
      fits: [],
      priceFeatures: null,
    });
    mockStrategies.mockResolvedValue(null);
    render(await Page({ params: Promise.resolve({ stockCode: "NEW" }) }));
    expect(screen.getByTestId("regime")).toBeInTheDocument();
    expect(screen.queryByTestId("levels-chart")).not.toBeInTheDocument();
    expect(screen.getByText(/needs more price history/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /stock picker/ })).toHaveAttribute(
      "href",
      "/picks",
    );
    await generateMetadata({ params: Promise.resolve({ stockCode: "NEW" }) });
    expect(mockMetadata.mock.calls[0]![0]).toMatchObject({
      tab: "strategy",
      forceNoindex: true,
    });
  });

  it("fails the render on a fit failure rather than caching an empty page", async () => {
    // loadFit logs the failure it hides from the metadata; keep the run quiet
    // and say so in the assertion.
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      mockFit.mockRejectedValue(new Error("timeout"));
      mockStrategies.mockResolvedValue(null);
      await expect(
        Page({ params: Promise.resolve({ stockCode: "BHP" }) }),
      ).rejects.toThrow(/strategy fit unavailable/);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("strategy fit unavailable for BHP"),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("is on-demand ISR", () => {
    expect(revalidate).toBe(3600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("builds its metadata through the shared builder with the tab's title, description and keywords", async () => {
    mockFit.mockResolvedValue(fit);
    await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    const input = mockMetadata.mock.calls[0]![0] as {
      code: string;
      tab: string;
      title: (c: string) => string;
      description: (c: string) => string;
      keywords: string[];
      forceNoindex: boolean;
    };
    expect(input.code).toBe("BHP");
    expect(input.tab).toBe("strategy");
    expect(input.title("BHP Group")).toBe(
      "BHP Strategy Fit: Breakout, CANSLIM & Trend Rules | BHP Group",
    );
    expect(input.description("BHP Group")).toContain("BHP Group (ASX:BHP)");
    expect(input.keywords).toEqual([
      "BHP breakout",
      "BHP CANSLIM",
      "BHP trend template",
      "BHP stock picker",
    ]);
    expect(input.forceNoindex).toBe(false);
  });

  it("does not noindex a stock whose fit cannot be read: metadata fails open, as the other tabs do", async () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      mockFit.mockRejectedValue(new Error("timeout"));
      await generateMetadata({ params: Promise.resolve({ stockCode: "BHP" }) });
      expect(mockMetadata.mock.calls[0]![0]).toMatchObject({
        tab: "strategy",
        forceNoindex: false,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("makes no fit request for a malformed code, in the page or its metadata", async () => {
    await generateMetadata({
      params: Promise.resolve({ stockCode: "not-a-code" }),
    });
    await expect(
      Page({ params: Promise.resolve({ stockCode: "not-a-code" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockFit).not.toHaveBeenCalled();
    expect(mockStrategies).not.toHaveBeenCalled();
  });

  it("emits breadcrumb structured data with the tab as the last item, labelled by the tab registry", async () => {
    mockFit.mockResolvedValue(fit);
    mockStrategies.mockResolvedValue(strategies);
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(stockTabLabel).toHaveBeenCalledWith("strategy");
    expect(mockBreadcrumbs).toHaveBeenCalledWith({
      items: [
        { label: "Stocks", href: "/stocks" },
        { label: "BHP", href: "/shorts/BHP" },
        { label: "Strategy", href: "/shorts/BHP/strategy" },
      ],
    });
  });

  it("has one h1, one heading for the chart (the island prints none of its own) and one per panel", async () => {
    mockFit.mockResolvedValue(fit);
    mockStrategies.mockResolvedValue(strategies);
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "BHP strategy fit",
    );
    // The h1, the section heading that names the chart, then one h2 per panel.
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "BHP strategy fit",
      "Levels on the chart",
      "Minervini Trend Template",
      "CAN SLIM",
    ]);
  });

  it("hands the chart the upper-cased code, the fits strongest first and the price features", async () => {
    mockFit.mockResolvedValue(fit);
    mockStrategies.mockResolvedValue(strategies);
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const chart = screen.getByTestId("levels-chart");
    expect(chart).toHaveAttribute("data-code", "BHP");
    expect(chart).toHaveAttribute("data-fits", "2");
    // The segmented control follows this order, so it matches the panels'.
    expect(chart).toHaveAttribute(
      "data-order",
      "minervini-trend-template,canslim",
    );
    expect(chart).toHaveAttribute("data-features", "yes");
  });

  it("still renders the panels and the chart when the API sent no price features", async () => {
    mockFit.mockResolvedValue({ ...fit, priceFeatures: null });
    mockStrategies.mockResolvedValue(strategies);
    render(await Page({ params: Promise.resolve({ stockCode: "BHP" }) }));
    expect(screen.getByTestId("levels-chart")).toHaveAttribute(
      "data-features",
      "no",
    );
    expect(
      screen.getAllByRole("region", { name: /Trend Template|CAN SLIM/ }),
    ).toHaveLength(2);
  });

  it("renders every panel without the author's words when the definitions are unavailable", async () => {
    mockFit.mockResolvedValue(fit);
    mockStrategies.mockResolvedValue(null);
    render(await Page({ params: Promise.resolve({ stockCode: "BHP" }) }));
    const canslim = screen.getByRole("region", { name: /CAN SLIM/ });
    expect(within(canslim).getByText("Market direction")).toBeInTheDocument();
    expect(within(canslim).getByText("XJO uptrend")).toBeInTheDocument();
    expect(
      screen.queryByText("Only buy in a confirmed uptrend."),
    ).not.toBeInTheDocument();
  });

  it("dates the readings from the fit and links the disclaimer", async () => {
    mockFit.mockResolvedValue(fit);
    mockStrategies.mockResolvedValue(strategies);
    render(await Page({ params: Promise.resolve({ stockCode: "BHP" }) }));
    expect(screen.getByText(/Prices to 7 Oct 2026/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Mechanical readings of published rules, not recommendations/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Not financial advice" }),
    ).toHaveAttribute("href", "/disclaimer");
  });

  it("leaves the date out rather than guessing one when the fit carries none", async () => {
    mockFit.mockResolvedValue({ ...fit, asOf: "" });
    mockStrategies.mockResolvedValue(strategies);
    render(await Page({ params: Promise.resolve({ stockCode: "BHP" }) }));
    expect(screen.queryByText(/Prices to/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Mechanical readings of published rules/),
    ).toBeInTheDocument();
  });
});
