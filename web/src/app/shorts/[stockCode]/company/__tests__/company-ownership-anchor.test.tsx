/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// The Company card's anchor and its three states: the section the Overview's
// links and the register page's "How ownership is read" point at, the view when
// holders or fund rows are on record, one server-drawn line when the notices
// name no current holder, and nothing at all when the register knows nothing.
// StockOwnershipView is stubbed: its own markup is its test's.

const mockGetStockOrNotFound = jest.fn();
const mockGetRelatedStocks = jest.fn();
const mockGetStateExposureIndex = jest.fn();
const mockGetDirectorTrades = jest.fn();
const mockGetStockOwnership = jest.fn();

jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
jest.mock("next/dynamic", () => () => () => null);
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    prefetch,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock("~/app/actions/getStock", () => ({
  getStockOrNotFound: (...a: unknown[]) => mockGetStockOrNotFound(...a),
}));
jest.mock("~/app/actions/getRelatedStocks", () => ({
  getRelatedStocks: (...a: unknown[]) => mockGetRelatedStocks(...a),
}));
jest.mock("~/app/actions/getEconomy", () => ({
  getStateExposureIndex: (...a: unknown[]) => mockGetStateExposureIndex(...a),
}));
jest.mock("~/app/actions/getDirectorTrades", () => ({
  getDirectorTrades: (...a: unknown[]) => mockGetDirectorTrades(...a),
}));
jest.mock("~/app/actions/getOwnership", () => ({
  getStockOwnership: (...a: unknown[]) => mockGetStockOwnership(...a),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  BreadcrumbStructuredData: () => null,
}));
jest.mock("~/@/components/ownership/stock-ownership-view", () => ({
  StockOwnershipView: ({ data }: { data: { holders: unknown[]; fundHoldings: unknown[] } }) => (
    <div
      data-testid="ownership-view"
      data-holders={data.holders.length}
      data-funds={data.fundHoldings.length}
    />
  ),
}));
jest.mock("~/@/components/company/enriched-company-section", () => ({
  EnrichedCompanySection: () => null,
}));
jest.mock("~/@/components/company/politician-interests-card-loader", () => ({
  PoliticianInterestsCard: () => <div data-testid="politicians" />,
}));
jest.mock("~/@/components/economy/stock-state-exposure", () => ({
  StockStateExposure: () => null,
}));
jest.mock("~/@/components/company/stock-evidence-panel-client", () => ({
  StockEvidencePanelClient: () => null,
}));

import Page from "../page";

const stock = { name: "BHP GROUP LIMITED", industry: "Materials", percentageShorted: 1.58 };
const related = { stocks: [], industry: "Materials", industrySlug: "materials" };

const holder = {
  holderKey: "asx:VAN",
  holderName: "Vanguard Group",
  kind: "index_manager",
  votingPowerPct: 6.12,
  institutionSlug: "vanguard",
};
const fund = { fundName: "Vanguard Australian Shares Index", sourceKind: "etf" };

const withHolders = { holders: [holder], fundHoldings: [], historyTotal: 3, withheldListed: 0 };
const withFundsOnly = { holders: [], fundHoldings: [fund], historyTotal: 0, withheldListed: 0 };
const noticesOnly = { holders: [], fundHoldings: [], historyTotal: 4, withheldListed: 2 };
const nothingOnRecord = { holders: [], fundHoldings: [], historyTotal: 0, withheldListed: 0 };

const LINE_TAIL = " Full register → · How ownership is read →";

describe("/shorts/[stockCode]/company: the ownership anchor", () => {
  beforeEach(() => {
    mockGetStockOrNotFound.mockReset();
    mockGetStockOrNotFound.mockResolvedValue(stock);
    mockGetRelatedStocks.mockReset();
    mockGetRelatedStocks.mockResolvedValue(related);
    mockGetStateExposureIndex.mockReset();
    mockGetStateExposureIndex.mockResolvedValue({});
    mockGetDirectorTrades.mockReset();
    mockGetDirectorTrades.mockResolvedValue({ trades: [], totalCount: 0 });
    mockGetStockOwnership.mockReset();
    mockGetStockOwnership.mockResolvedValue(nothingOnRecord);
  });

  it("gives the section the id the Overview's links land on, with room for the docked tab bar", async () => {
    mockGetStockOwnership.mockResolvedValue(withHolders);
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const section = container.querySelector("section#ownership");
    expect(section).toHaveAttribute("aria-label", "Ownership");
    expect(section).toHaveClass("scroll-mt-[124px]");
  });

  it("reads the register for the upper-cased code", async () => {
    await Page({ params: Promise.resolve({ stockCode: "bhp" }) });
    expect(mockGetStockOwnership).toHaveBeenCalledWith("BHP");
  });

  it("draws the ownership view when a holder is current", async () => {
    mockGetStockOwnership.mockResolvedValue(withHolders);
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const section = container.querySelector("section#ownership") as HTMLElement;
    expect(within(section).getByTestId("ownership-view")).toHaveAttribute("data-holders", "1");
    expect(within(section).queryByText(/No current substantial holder read/)).toBeNull();
  });

  it("draws the ownership view when only index fund or super option rows are on record", async () => {
    mockGetStockOwnership.mockResolvedValue(withFundsOnly);
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const section = container.querySelector("section#ownership") as HTMLElement;
    expect(within(section).getByTestId("ownership-view")).toHaveAttribute("data-holders", "0");
    expect(within(section).getByTestId("ownership-view")).toHaveAttribute("data-funds", "1");
  });

  it("says in one line that the notices on record name no current holder, and links the register and the method", async () => {
    mockGetStockOwnership.mockResolvedValue(noticesOnly);
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const section = container.querySelector("section#ownership") as HTMLElement;
    expect(within(section).queryByTestId("ownership-view")).toBeNull();

    const line = section.querySelector("p");
    expect(line?.textContent).toBe(
      "No current substantial holder read for BHP: each holding in its 4 notices read has since ceased; 2 notices listed under it were withheld." +
        LINE_TAIL,
    );
    expect(line).toHaveClass("text-sm", "text-muted-foreground");

    const register = within(section).getByRole("link", { name: "Full register →" });
    expect(register).toHaveAttribute("href", "/ownership/stocks/BHP");
    expect(register).toHaveAttribute("data-prefetch", "false");
    expect(within(section).getByRole("link", { name: "How ownership is read →" })).toHaveAttribute(
      "href",
      "/ownership#method",
    );
  });

  it.each([
    [
      { historyTotal: 0, withheldListed: 3 },
      "No current substantial holder read for BHP; 3 notices listed under it were withheld." + LINE_TAIL,
    ],
    [
      { historyTotal: 2, withheldListed: 0 },
      "No current substantial holder read for BHP: each holding in its 2 notices read has since ceased." + LINE_TAIL,
    ],
  ])("leaves out the clause whose count is zero (%j)", async (counts, text) => {
    mockGetStockOwnership.mockResolvedValue({ ...nothingOnRecord, ...counts });
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const section = container.querySelector("section#ownership") as HTMLElement;
    expect(section.querySelector("p")?.textContent).toBe(text);
  });

  it("prints nothing when the register knows nothing of the stock, or when the read failed", async () => {
    const check = async () => {
      const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
      expect(container.querySelector("#ownership")).toBeNull();
      expect(container.querySelector('section[aria-label="Ownership"]')).toBeNull();
    };
    mockGetStockOwnership.mockResolvedValue(nothingOnRecord);
    await check();
    mockGetStockOwnership.mockResolvedValue(undefined);
    await check();
  });

  it("keeps the section between the directors card and the politicians card", async () => {
    mockGetStockOwnership.mockResolvedValue(withHolders);
    const { container } = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const directors = container.querySelector('section[aria-label="Directors and insiders"]') as HTMLElement;
    const section = container.querySelector("section#ownership") as HTMLElement;
    const politicians = screen.getByTestId("politicians");
    expect(directors.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.compareDocumentPosition(politicians) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is in the server HTML, so the line holds its place before any script runs", async () => {
    mockGetStockOwnership.mockResolvedValue(noticesOnly);
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    expect(html).toContain('id="ownership"');
    expect(html).toContain("scroll-mt-[124px]");
    expect(html).toContain("No current substantial holder read for BHP");
  });
});
