/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

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

import Page, { generateMetadata, generateStaticParams, revalidate, dynamicParams } from "../page";
import { NotFoundError } from "~/app/actions/withRetry";

const stock = { name: "BHP GROUP LIMITED ORDINARY", industry: "Materials", percentageShorted: 1.58 };

describe("/shorts/[stockCode]/short-interest", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockReset();
    mockGetStockOrNotFound.mockResolvedValue(stock);
    mockMetadata.mockClear();
    mockBreadcrumbs.mockClear();
  });

  it("is on-demand ISR", () => {
    expect(revalidate).toBe(3600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("renders the history with the cleaned company name, then the three islands", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP short interest history");
    expect(screen.getByTestId("history")).toHaveTextContent("BHP:BHP Group");
    expect(screen.getAllByTestId("island")).toHaveLength(3);
  });

  it("emits breadcrumb structured data with the tab as the last item", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
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
