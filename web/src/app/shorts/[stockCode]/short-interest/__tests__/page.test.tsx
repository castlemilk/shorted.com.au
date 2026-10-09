/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

const mockGetStockOrNotFound = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({ title: "t" });
const mockBreadcrumbs = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("next/dynamic", () => () => () => <div data-testid="island" />);
jest.mock("~/app/actions/getStock", () => ({ getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a) }));
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
