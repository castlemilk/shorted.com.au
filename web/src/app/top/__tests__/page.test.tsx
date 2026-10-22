import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TopPage from "../page";
import { TopPageClient } from "../top-page-client";
import { SPARKLINE_POINTS } from "~/app/actions/top/top-rows";
import type { TopPageData } from "~/app/actions/top/getTopPageData";

const getTopPageData = jest.fn();
jest.mock("~/app/actions/top/getTopPageData", () => ({
  getTopPageData: (...args: unknown[]) => getTopPageData(...args),
  getTopRowsForPeriod: jest.fn(),
}));
jest.mock("~/@/components/reports/latest-weekly-report-link", () => ({
  LatestWeeklyReportLink: () => null,
}));
jest.mock("~/@/components/reports/reports-banner", () => ({
  ReportsBanner: () => null,
}));
jest.mock("~/app/treemap/treeMap", () => ({
  IndustryTreeMapView: () => null,
}));
// The shared radix-select stub has no Icon, Portal or Viewport.
jest.mock("~/@/components/ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Pass,
    SelectContent: Pass,
    SelectItem: Pass,
    SelectTrigger: Pass,
    SelectValue: () => null,
  };
});

/** The cached shape as production serves it: 100 series of 60 dated points. */
function cachedTopPageData(): TopPageData {
  const start = Date.UTC(2026, 6, 16);
  const timeSeries = Array.from({ length: 100 }, (_, index) => {
    const points = Array.from({ length: 60 }, (_, day) => ({
      timestamp: new Date(start + day * 86_400_000).toISOString(),
      shortPosition: 20 - index * 0.17 + Math.sin(day / 6 + index) * 0.87036002,
    }));
    return {
      productCode: `C${String(index).padStart(2, "0")}`,
      name: `Company Number ${index} Limited`,
      latestShortPosition: points[59]!.shortPosition,
      points,
      max: points[10],
      min: points[40],
    };
  });
  const summary = (index: number) => ({
    productCode: timeSeries[index]!.productCode,
    name: timeSeries[index]!.name,
    latestShortPosition: timeSeries[index]!.latestShortPosition,
  });
  return {
    timeSeries,
    movers: {
      biggestGainers: [0, 1, 2, 3, 4].map((i) => ({ ...summary(i), change: 1.5 })),
      biggestLosers: [5, 6, 7, 8, 9].map((i) => ({ ...summary(i), change: -1.5 })),
      mostVolatile: [10, 11, 12, 13, 14].map((i) => ({ ...summary(i), volatility: 2 })),
    },
    stockListItems: timeSeries.slice(0, 20).map((stock, index) => ({
      productCode: stock.productCode,
      name: stock.name,
      shortPercentage: stock.latestShortPosition,
      url: `https://shorted.com.au/shorts/${stock.productCode}`,
      rank: index + 1,
    })),
    lastUpdated: timeSeries[0]!.points[59]!.timestamp!,
    period: "3m",
  };
}

function find(
  node: ReactNode,
  match: (element: ReactElement) => boolean,
): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (match(node)) return node;
  const props = node.props as { children?: ReactNode; fallback?: ReactNode };
  return find(props.children, match);
}

/** The streamed TopPageData segment, resolved the way the server renders it. */
async function topPageData(): Promise<ReactNode> {
  const segment = find(
    TopPage(),
    (element) =>
      typeof element.type === "function" && element.type.name === "TopPageData",
  );
  if (!segment) throw new Error("no TopPageData segment");
  return (segment.type as () => Promise<ReactNode>)();
}

function islandProps(tree: ReactNode): Parameters<typeof TopPageClient>[0] {
  const island = find(tree, (element) => "initialData" in (element.props as object));
  if (!island) throw new Error("no TopPageClient");
  return island.props as Parameters<typeof TopPageClient>[0];
}

describe("/top page", () => {
  let data: TopPageData;

  beforeEach(() => {
    data = cachedTopPageData();
    getTopPageData.mockResolvedValue(data);
  });

  // Measured 2026-10-21: the island was handed the cached series, 394 KB of
  // the page's 438 KB RSC payload, to draw a latest value, a change and a
  // 180px sparkline per row. Its props are serialised into that payload.
  it("hands the island under 60 KB of props for 100 rows", async () => {
    const props = islandProps(await topPageData());

    expect(JSON.stringify(data.timeSeries).length).toBeGreaterThan(300 * 1024);
    expect(JSON.stringify(props).length).toBeLessThan(60 * 1024);
    expect(props.initialData).toHaveLength(100);
    for (const row of props.initialData) {
      expect(Object.keys(row).sort()).toEqual(
        ["change", "latestShortPosition", "name", "productCode", "sparkline"],
      );
      expect(row.sparkline.length).toBeLessThanOrEqual(SPARKLINE_POINTS);
    }
    expect(props.dataAsOf).toBe(data.lastUpdated);
  });

  it("keeps the ItemList and Dataset JSON-LD on the cached data", async () => {
    const tree = await topPageData();
    const itemList = find(tree, (element) => "items" in (element.props as object));
    const items = (itemList!.props as { items: Array<{ name: string; url: string }> }).items;

    expect(items).toHaveLength(20);
    expect(items[0]).toMatchObject({
      name: "C00 - Company Number 0 Limited",
      url: "https://shorted.com.au/shorts/C00",
    });
    const dataset = find(tree, (element) => "datasetInfo" in (element.props as object));
    expect((dataset!.props as { datasetInfo: { dateModified: string } }).datasetInfo.dateModified).toBe(
      data.lastUpdated,
    );
  });

  // getTopPageData's lastUpdated is the render time for an empty series
  // (getLastUpdatedTimestamp), which the Dataset reported as its data date.
  it("dates neither the Dataset nor the island without a dated point", async () => {
    getTopPageData.mockResolvedValue({
      ...data,
      timeSeries: [],
      stockListItems: [],
      lastUpdated: "2026-10-22T03:14:15.000Z",
    });
    const tree = await topPageData();

    const dataset = find(tree, (element) => "datasetInfo" in (element.props as object));
    const info = (dataset!.props as { datasetInfo: Record<string, unknown> }).datasetInfo;
    expect(info.dateModified).toBeUndefined();
    expect(islandProps(tree).dataAsOf).toBeUndefined();
  });

  it("server-renders every ranked stock as a link, with its short % and change", async () => {
    const props = islandProps(await topPageData());
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<TopPageClient {...props} />);

    const rows = [
      ...host.querySelectorAll<HTMLAnchorElement>(
        'section[aria-labelledby="rankings-title"] a[href^="/shorts/"]',
      ),
    ];
    expect(rows.map((link) => link.getAttribute("href"))).toEqual(
      data.timeSeries.map((stock) => `/shorts/${stock.productCode}`),
    );

    const first = data.timeSeries[0]!;
    const change = first.latestShortPosition - first.points[0]!.shortPosition;
    const formatted = new Intl.NumberFormat("en-AU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      signDisplay: "always",
    }).format(change);
    expect(rows[0]!.textContent).toContain(`${first.latestShortPosition.toFixed(2)}%`);
    expect(rows[0]!.textContent).toContain(`${formatted}%`);
  });
});
