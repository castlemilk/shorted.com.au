/// <reference types="jest" />

import { render, screen, within } from "@testing-library/react";
import type { FundRow } from "~/@/components/ownership/funds/fund-model";

const mockLoadFunds = jest.fn();
const mockBail = jest.fn(async () => undefined);

jest.mock("~/app/actions/ownershipFunds", () => ({
  loadFunds: () => mockLoadFunds(),
  resolveFundSelection: jest.fn(async () => null),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => mockBail(),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="dashboard-layout">{children}</div>,
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/funds",
  useRouter: () => ({ replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import FundsPage, { revalidate } from "./page";

const FUND: FundRow = {
  key: "A200",
  ticker: "A200",
  name: "BetaShares Australia 200 ETF",
  institutionSlug: "betashares",
  institutionName: "Betashares",
  sourceKind: "etf",
  pooled: false,
  asAt: "2026-10-31",
  sourceUrl: "https://example.com/a200.csv",
  holdings: 198,
  top10Pct: 44.2,
  sectorWeights: [{ industry: "Banks", weightPct: 30 }],
  largest: [],
  aumAud: null,
};

describe("the funds page (spec 14.3, static ISR)", () => {
  beforeEach(() => {
    mockLoadFunds.mockReset();
    mockBail.mockClear();
  });

  it("is static ISR: an hour, and it takes no search parameter", () => {
    expect(revalidate).toBe(3600);
    expect(FundsPage.length).toBe(0);
  });

  it("draws the heading, the lede and the exposure map of the funds it read", async () => {
    mockLoadFunds.mockResolvedValue({ ok: true, error: "", funds: [FUND] });
    render(await FundsPage());
    expect(screen.getByRole("heading", { level: 1, name: "Explore fund portfolios" })).toBeInTheDocument();
    expect(screen.getByText("Compare the shape of reported portfolios, then open a fund.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(mockBail).not.toHaveBeenCalled();
  });

  it("prints the status line beside the page title, as the wireframe does", async () => {
    mockLoadFunds.mockResolvedValue({ ok: true, error: "", funds: [FUND] });
    render(await FundsPage());
    const title = screen.getByRole("heading", { level: 1, name: "Explore fund portfolios" });
    expect(title.closest("header")).toHaveTextContent("Tracked portfolios only · Snapshot dates vary");
  });

  it("bails an outage rather than drawing an empty fund list as the answer", async () => {
    mockLoadFunds.mockResolvedValue({ ok: false, error: "", funds: [] });
    render(await FundsPage());
    expect(mockBail).toHaveBeenCalled();
    expect(screen.getByText(/this is our end/)).toBeInTheDocument();
  });

  it("marks its shell so the post-deploy sweep re-primes it, the build's empty render included", async () => {
    mockLoadFunds.mockResolvedValue({ ok: false, error: "", funds: [] });
    const { container } = render(await FundsPage());
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
  });

  it("ends the main column with the closed method disclosure, its text in the HTML", async () => {
    mockLoadFunds.mockResolvedValue({ ok: true, error: "", funds: [FUND] });
    const { container } = render(await FundsPage());
    const method = container.querySelector("details#method") as HTMLElement | null;
    expect(method).not.toBeNull();
    expect(method).not.toHaveAttribute("open");
    expect(within(method as HTMLElement).getByText("How these figures are read")).toBeInTheDocument();
    expect(method?.textContent).toMatch(/what the notices disclose, not a share of the company/);
    expect(method?.nextElementSibling).toBeNull();
  });
});
