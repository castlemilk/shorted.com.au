/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockGetStock = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({ title: "t" });
const mockBreadcrumbs = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
// Every client island the page loads stands in as one div. The chart panel is
// the only one handed a settings key and a view, so those tell it apart.
jest.mock("next/dynamic", () => () => (props: { prefsKey?: string; defaultView?: string }) => (
  <div data-testid="island" data-prefs-key={props.prefsKey} data-default-view={props.defaultView} />
));
jest.mock("~/app/actions/getStock", () => ({
  getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a),
  // The real metadata builder reads the stock through getStock.
  getStock: (...a: unknown[]) => mockGetStock(...a),
}));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: (...a: unknown[]) => mockMetadata(...a) }));
jest.mock("../../short-interest-history", () => ({
  ShortInterestHistory: ({ stockCode, companyName }: { stockCode: string; companyName: string }) => (
    <div data-testid="history">{stockCode}:{companyName}</div>
  ),
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
  const actual = jest.requireActual<typeof import("~/@/lib/stocks/stock-tabs")>("~/@/lib/stocks/stock-tabs");
  return { ...actual, stockTabLabel: jest.fn(actual.stockTabLabel) };
});

import Page, { generateMetadata, generateStaticParams, revalidate, dynamicParams } from "../page";
import { NotFoundError } from "~/app/actions/withRetry";
import { stockTabLabel } from "~/@/lib/stocks/stock-tabs";

const stock = { name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58 };

describe("/shorts/[stockCode]/short-interest", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockReset();
    mockGetStockOrNotFound.mockResolvedValue(stock);
    mockGetStock.mockReset();
    mockMetadata.mockClear();
    mockBreadcrumbs.mockClear();
    (stockTabLabel as jest.Mock).mockClear();
  });

  it("is on-demand ISR", () => {
    expect(revalidate).toBe(3600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("renders the chart first, then the history with the cleaned company name, then the three islands", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP Group (BHP) short interest history");
    expect(screen.getByTestId("history")).toHaveTextContent("BHP:BHP Group");
    expect(screen.getByRole("region", { name: "Short interest history and FAQ" })).toContainElement(screen.getByTestId("history"));
    // The chart panel and the three that were here before: the verdict, the signals, the peers.
    const islands = screen.getAllByTestId("island");
    expect(islands).toHaveLength(4);
    const chart = screen.getByRole("region", { name: "Short interest chart" });
    expect(chart).toContainElement(islands[0]!);
    expect(islands[0]!.compareDocumentPosition(screen.getByTestId("history")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/ASIC reports no short position/)).not.toBeInTheDocument();
  });

  it("opens the chart on the short series, under its own settings key, for a stock with a short history", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const [chart] = screen.getAllByTestId("island");
    expect(chart).toHaveAttribute("data-prefs-key", "BHP:short-interest");
    expect(chart).toHaveAttribute("data-default-view", "short");
    // The only island with settings: the other three have none to keep.
    expect(screen.getAllByTestId("island").filter((i) => i.hasAttribute("data-prefs-key"))).toHaveLength(1);
  });

  it("opens the chart on the combined view when ASIC reports no short position, which leaves the short series nothing to show", async () => {
    mockGetStockOrNotFound.mockResolvedValue({ ...stock, percentageShorted: 0 });
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const [chart] = screen.getAllByTestId("island");
    expect(chart).toHaveAttribute("data-prefs-key", "BHP:short-interest");
    expect(chart).toHaveAttribute("data-default-view", "combined");
  });

  it("says so in one sentence, with no history card, when ASIC reports no short position", async () => {
    mockGetStockOrNotFound.mockResolvedValue({ ...stock, percentageShorted: 0 });
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByText("ASIC reports no short position in BHP in the latest data.")).toBeInTheDocument();
    expect(screen.queryByTestId("history")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Short interest history and FAQ" })).not.toBeInTheDocument();
    // Only the history is gated: the chart, the verdict, the signals and the peers still render.
    expect(screen.getAllByTestId("island")).toHaveLength(4);
  });

  it("adds no heading of its own over the islands but the chart's, which prints no title", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    // The h1 and the chart section's h2 are the only headings the page writes:
    // the chart panel prints no title of its own, while the history and the peer
    // table each print theirs, so a wrapper heading over them would say it twice.
    expect(screen.getAllByRole("heading").map((h) => [h.tagName, h.textContent])).toEqual([
      ["H1", "BHP Group (BHP) short interest history"],
      ["H2", "Short interest chart"],
    ]);
    const peers = screen.getByRole("region", { name: "Peer comparison" });
    expect(within(peers).getAllByTestId("island")).toHaveLength(1);
  });

  it("names the chart section by its own heading, which the section can shrink around", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const chart = screen.getByRole("region", { name: "Short interest chart" });
    expect(chart).toHaveClass("min-w-0");
    expect(within(chart).getByRole("heading", { level: 2 })).toHaveAttribute("id", "stock-chart-heading");
    expect(chart).toHaveAttribute("aria-labelledby", "stock-chart-heading");
  });

  // With a history, its own h2 is the first heading after the h1. Without one
  // the tab goes from the sentence straight to CardTitles (h3), so a single
  // sr-only h2 keeps the outline from skipping a level.
  it("puts an sr-only h2 over the islands, after the sentence, when there is no history to supply one", async () => {
    mockGetStockOrNotFound.mockResolvedValue({ ...stock, percentageShorted: 0 });
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const headings = screen.getAllByRole("heading");
    expect(headings.map((h) => [h.tagName, h.textContent])).toEqual([
      ["H1", "BHP Group (BHP) short interest history"],
      ["H2", "Short interest chart"],
      ["H2", "Signals and peer comparison"],
    ]);
    expect(headings[2]).toHaveClass("sr-only");
    const sentence = screen.getByText("ASIC reports no short position in BHP in the latest data.");
    // The chart is the first island and sits above the sentence; the sr-only h2
    // names the group that follows it, so the first island it precedes is the next.
    const [, firstGroupedIsland] = screen.getAllByTestId("island");
    expect(sentence.compareDocumentPosition(headings[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(headings[2]!.compareDocumentPosition(firstGroupedIsland!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("adds no h2 beyond the chart's when the history, which prints one, is there", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Short interest chart"]);
  });

  it("emits breadcrumb structured data with the tab as the last item, labelled by the tab registry", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(stockTabLabel).toHaveBeenCalledWith("short-interest");
    expect(mockBreadcrumbs).toHaveBeenCalledWith({
      items: [
        { label: "Stocks", href: "/stocks" },
        { label: "BHP", href: "/shorts/BHP" },
        { label: "Short interest", href: "/shorts/BHP/short-interest" },
      ],
    });
  });

  it("builds its metadata through the shared builder with the tab's title", async () => {
    await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    const input = mockMetadata.mock.calls[0]![0] as { code: string; tab: string; title: (c: string) => string };
    expect(input.code).toBe("BHP");
    expect(input.tab).toBe("short-interest");
    expect(input.title("BHP Group")).toBe("BHP Short Interest History & FAQ | BHP Group");
    // stockTabTitle's 60-character budget: a name that does not fit, or the
    // code standing in for one, is left to the description.
    expect(input.title("Commonwealth Bank of Australia")).toBe("BHP Short Interest History & FAQ");
    expect(input.title("BHP")).toBe("BHP Short Interest History & FAQ");
  });

  // A stock ASIC reports no short position in gets a one-sentence tab, and a
  // named, enriched one would otherwise be indexed (isStockIndexable admits any
  // stock with an industry). The reason is a predicate over the stock record,
  // not a flag: a flag worked out before the read would noindex every stock for
  // as long as getStock is failing.
  describe("noindex for a stock with no reported short position", () => {
    it("hands the builder a predicate, never a flag", async () => {
      await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
      const input = mockMetadata.mock.calls[0]![0] as {
        forceNoindex?: boolean;
        noindexWhen?: (stock: { percentageShorted?: number }) => boolean;
      };
      expect(input.forceNoindex).toBeUndefined();
      expect(input.noindexWhen).toEqual(expect.any(Function));
      // Not greater than zero: none reported, a missing figure, or one that is not a number.
      expect(input.noindexWhen!({ percentageShorted: 0 })).toBe(true);
      expect(input.noindexWhen!({})).toBe(true);
      expect(input.noindexWhen!({ percentageShorted: Number.NaN })).toBe(true);
      expect(input.noindexWhen!({ percentageShorted: 0.01 })).toBe(false);
      expect(input.noindexWhen!({ percentageShorted: 1.58 })).toBe(false);
    });

    it("composes with the real builder: noindex once the stock is read, fail open while it cannot be", async () => {
      await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
      const input = mockMetadata.mock.calls[0]![0];
      const { stockTabMetadata: realBuilder } = jest.requireActual<
        typeof import("~/@/lib/seo/stock-tab-metadata")
      >("~/@/lib/seo/stock-tab-metadata");
      const indexableOtherwise = { name: "BHP GROUP LIMITED", industry: "Materials" };

      mockGetStock.mockResolvedValue({ ...indexableOtherwise, percentageShorted: 0 });
      expect((await realBuilder(input)).robots).toMatchObject({ index: false, follow: true });

      mockGetStock.mockResolvedValue({ ...indexableOtherwise, percentageShorted: 1.58 });
      expect((await realBuilder(input)).robots).toBeUndefined();

      // getStock resolves undefined for a code it cannot read: every tab stays
      // indexable rather than every stock going noindex during an outage.
      mockGetStock.mockResolvedValue(undefined);
      expect((await realBuilder(input)).robots).toBeUndefined();
      mockGetStock.mockRejectedValue(new Error("down"));
      expect((await realBuilder(input)).robots).toBeUndefined();
    });
  });

  it("404s a malformed code before any fetch", async () => {
    await expect(Page({ params: Promise.resolve({ stockCode: "not-a-code" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetStockOrNotFound).not.toHaveBeenCalled();
  });

  it("404s a code the API does not know", async () => {
    mockGetStockOrNotFound.mockRejectedValue(new NotFoundError("ZZZZ"));
    await expect(Page({ params: Promise.resolve({ stockCode: "ZZZZ" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("fails the ISR render on a transient read instead of caching a degraded page", async () => {
    mockGetStockOrNotFound.mockResolvedValue(undefined);
    await expect(Page({ params: Promise.resolve({ stockCode: "BHP" }) })).rejects.toThrow(/transiently unavailable/);
  });
});
