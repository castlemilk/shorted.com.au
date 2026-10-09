/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockMetadata = jest.fn().mockResolvedValue({});
const mockBreadcrumbs = jest.fn();
jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
jest.mock("~/@/lib/seo/stock-tab-metadata", () => ({ stockTabMetadata: (...a: unknown[]) => mockMetadata(...a) }));
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
jest.mock("~/@/components/company/community/community-tab", () => ({
  CommunityTab: ({ stockCode }: { stockCode: string }) => <div data-testid="community">{stockCode}</div>,
}));

import Page, { generateMetadata, generateStaticParams, revalidate, dynamicParams } from "../page";
import { stockTabLabel } from "~/@/lib/stocks/stock-tabs";

describe("/shorts/[stockCode]/community", () => {
  beforeEach(() => {
    mockMetadata.mockClear();
    mockBreadcrumbs.mockClear();
    (stockTabLabel as jest.Mock).mockClear();
  });

  it("is ISR, renders the tab, and is never indexed", async () => {
    expect(revalidate).toBe(3600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(screen.getByTestId("community")).toHaveTextContent("BHP");
    await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    expect(mockMetadata.mock.calls[0]![0]).toMatchObject({ code: "BHP", tab: "community", forceNoindex: true });
  });

  it("gives the metadata builder the community title and description", async () => {
    await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    const input = mockMetadata.mock.calls[0]![0] as {
      title: (c: string) => string;
      description: (c: string) => string;
    };
    expect(input.title("BHP Group")).toBe("BHP Community Discussion | BHP Group");
    expect(input.description("BHP Group")).toContain("BHP Group (ASX:BHP)");
  });

  it("adds only a screen-reader h1 over an island whose lists print their own titles", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    // Research Threads and Live Pulse are the island's own headings, so the
    // page writes just the h1, and keeps it out of sight.
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("BHP community");
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("sr-only");
  });

  it("emits breadcrumb structured data with the tab as the last item, labelled by the tab registry", async () => {
    render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(stockTabLabel).toHaveBeenCalledWith("community");
    expect(mockBreadcrumbs).toHaveBeenCalledWith({
      items: [
        { label: "Stocks", href: "/stocks" },
        { label: "BHP", href: "/shorts/BHP" },
        { label: "Community", href: "/shorts/BHP/community" },
      ],
    });
  });

  it("404s a malformed code", async () => {
    await expect(Page({ params: Promise.resolve({ stockCode: "nope!" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
