/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockGetStock = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({ title: "t" });
const mockBreadcrumbs = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("next/dynamic", () => () => () => <div data-testid="island" />);
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

  it("renders the history with the cleaned company name, then the three islands", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP Group (BHP) short interest history");
    expect(screen.getByTestId("history")).toHaveTextContent("BHP:BHP Group");
    expect(screen.getByRole("region", { name: "Short interest history and FAQ" })).toContainElement(screen.getByTestId("history"));
    expect(screen.getAllByTestId("island")).toHaveLength(3);
    expect(screen.queryByText(/ASIC reports no short position/)).not.toBeInTheDocument();
  });

  it("says so in one sentence, with no history card, when ASIC reports no short position", async () => {
    mockGetStockOrNotFound.mockResolvedValue({ ...stock, percentageShorted: 0 });
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByText("ASIC reports no short position in BHP in the latest data.")).toBeInTheDocument();
    expect(screen.queryByTestId("history")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Short interest history and FAQ" })).not.toBeInTheDocument();
    // Only the history is gated: the verdict, the signals and the peers still render.
    expect(screen.getAllByTestId("island")).toHaveLength(3);
  });

  it("adds no heading of its own over the islands, which render their own titles", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    // The h1 is the only heading the page writes: the history and the peer table
    // each print their own title, so a wrapper heading would say it twice.
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    const peers = screen.getByRole("region", { name: "Peer comparison" });
    expect(within(peers).getAllByTestId("island")).toHaveLength(1);
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
      ["H2", "Signals and peer comparison"],
    ]);
    expect(headings[1]).toHaveClass("sr-only");
    const sentence = screen.getByText("ASIC reports no short position in BHP in the latest data.");
    const [firstIsland] = screen.getAllByTestId("island");
    expect(sentence.compareDocumentPosition(headings[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(headings[1]!.compareDocumentPosition(firstIsland!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("adds no h2 of its own when the history, which prints one, is there", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
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
