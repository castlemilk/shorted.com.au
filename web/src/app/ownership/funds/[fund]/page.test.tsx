/// <reference types="jest" />

import { render, screen } from "@testing-library/react";

const mockLoadFundPortfolio = jest.fn();
const mockCompare = jest.fn();
const mockBail = jest.fn(async () => undefined);
const mockSearch = { value: "" };

jest.mock("~/app/actions/ownershipFunds", () => ({
  loadFundPortfolio: (input: unknown) => mockLoadFundPortfolio(input),
  compareFundSnapshots: (input: unknown) => mockCompare(input),
  resolveFundSelection: jest.fn(async () => null),
  resolveChangeSelection: jest.fn(async () => null),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => mockBail(),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="dashboard-layout">{children}</div>,
}));
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
jest.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
  usePathname: () => "/ownership/funds/asx%3AA200",
  useRouter: () => ({ replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch.value),
}));
jest.mock("~/@/components/ownership/funds/fund-portfolio-map", () => ({
  FundPortfolioMap: () => <div>portfolio map stub</div>,
}));

import FundPage, { dynamicParams, generateStaticParams, revalidate } from "./page";

const PORTFOLIO = {
  key: "asx:A200",
  ticker: "A200",
  name: "BetaShares Australia 200 ETF",
  institutionSlug: "betashares",
  institutionName: "Betashares",
  sourceKind: "etf",
  pooled: false,
  asAt: "2026-10-31",
  sourceUrl: "",
  snapshotDates: ["2026-09-30", "2026-10-31"],
  holdings: [],
  holdingsTotal: 198,
  top10Pct: 44.2,
  sectorWeights: [],
};

const props = (fund: string) => ({ params: Promise.resolve({ fund }) });

/** The text a rendered element tree carries, for asserting copy without a DOM. */
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

describe("the fund page (spec 14.3, ISR segment)", () => {
  beforeEach(() => {
    mockLoadFundPortfolio.mockReset();
    mockCompare.mockReset();
    mockBail.mockClear();
    mockNotFound.mockClear();
  });

  it("is on-demand ISR for an hour, with an empty static set, so the segment stays static", async () => {
    expect(revalidate).toBe(3600);
    expect(dynamicParams).toBe(true);
    expect(generateStaticParams()).toEqual([]);
  });

  it("answers a fund the record does not hold with the workspace's own card, never the site 404 (spec 14.9)", async () => {
    mockLoadFundPortfolio.mockResolvedValue({ ok: false, missing: true, error: "", fund: null });
    const element = await FundPage(props("asx:NOPE"));
    expect(textOf(element)).toContain("No tracked fund named asx:NOPE.");
    expect(textOf(element)).toContain("Browse the funds →");
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("decodes the segment once and takes an already-decoded key as it is (spec 14.9)", async () => {
    mockLoadFundPortfolio.mockResolvedValue({ ok: false, missing: true, error: "", fund: null });
    await FundPage(props("vanguard%2FVanguard%20Shares"));
    expect(mockLoadFundPortfolio).toHaveBeenLastCalledWith({ fundKey: "vanguard/Vanguard Shares" });
    await FundPage(props("vanguard/Vanguard Shares"));
    expect(mockLoadFundPortfolio).toHaveBeenLastCalledWith({ fundKey: "vanguard/Vanguard Shares" });
  });

  it("refuses a path that is not a fund key without a read", async () => {
    await expect(FundPage(props("A/200"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockLoadFundPortfolio).not.toHaveBeenCalled();
  });

  it("reads a fund keyed by its institution slug and name from the decoded path segment, the slash and spaces included", async () => {
    mockLoadFundPortfolio.mockResolvedValue({ ok: true, missing: false, error: "", fund: { ...PORTFOLIO, key: "vanguard/Vanguard Australian Shares Index Fund" } });
    mockCompare.mockResolvedValue({ ok: true, from: "", to: "", sourceFrom: "", sourceTo: "", rows: [] });
    render(await FundPage(props("vanguard/Vanguard Australian Shares Index Fund")));
    expect(mockLoadFundPortfolio).toHaveBeenCalledWith({ fundKey: "vanguard/Vanguard Australian Shares Index Fund" });
  });

  it("says an outage is an outage, bails the cache, and never draws a 404", async () => {
    mockLoadFundPortfolio.mockResolvedValue({ ok: false, missing: false, error: "", fund: null });
    render(await FundPage(props("asx:A200")));
    expect(mockBail).toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(screen.getByText(/this is our end/)).toBeInTheDocument();
  });

  it("prints a stored source URL that is not http(s) as plain text, never as a link", async () => {
    mockLoadFundPortfolio.mockResolvedValue({ ok: true, missing: false, error: "", fund: { ...PORTFOLIO, sourceUrl: "javascript:alert(1)" } });
    mockCompare.mockResolvedValue({ ok: true, from: "2026-09-30", to: "2026-10-31", sourceFrom: "", sourceTo: "", rows: [] });
    mockSearch.value = "tab=sources";
    try {
      const { container } = render(await FundPage(props("asx:A200")));
      expect(screen.getByText("View holdings source")).toBeInTheDocument();
      expect(screen.getByText("View holdings source").closest("a")).toBeNull();
      expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    } finally {
      mockSearch.value = "";
    }
  });

  it("draws the fund's header and its three tabs, and compares its two newest files", async () => {
    mockLoadFundPortfolio.mockResolvedValue({ ok: true, missing: false, error: "", fund: PORTFOLIO });
    mockCompare.mockResolvedValue({ ok: true, from: "2026-09-30", to: "2026-10-31", sourceFrom: "", sourceTo: "", rows: [] });
    render(await FundPage(props("asx:A200")));
    expect(screen.getByRole("heading", { level: 1, name: "BetaShares Australia 200 ETF" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Portfolio", "Changes", "Sources & fund details"]);
    expect(mockCompare).toHaveBeenCalledWith({ fundKey: "asx:A200", from: "2026-09-30", to: "2026-10-31" });
    expect(mockBail).not.toHaveBeenCalled();
    expect(screen.getByText("reported equities", { exact: false })).toBeInTheDocument();
  });
});
