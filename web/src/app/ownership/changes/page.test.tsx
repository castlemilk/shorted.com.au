/// <reference types="jest" />

import { render, screen, within } from "@testing-library/react";

const mockLoadFunds = jest.fn();
const mockLoadFundPortfolio = jest.fn();
const mockCompare = jest.fn();
const mockBail = jest.fn(async () => undefined);

jest.mock("~/app/actions/ownershipFunds", () => ({
  loadFunds: () => mockLoadFunds(),
  loadFundPortfolio: (input: unknown) => mockLoadFundPortfolio(input),
  compareFundSnapshots: (input: unknown) => mockCompare(input),
  resolveChangeSelection: jest.fn(async () => null),
}));
jest.mock("~/app/actions/ownershipExplorer", () => ({
  loadNoticeFeed: jest.fn(async () => ({ ok: true, activityOk: true, rows: [{ id: "x" }] })),
}));
jest.mock("~/app/actions/getOwnership", () => ({
  listInstitutions: jest.fn(async () => ({ total: 0, institutions: [] })),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => mockBail(),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="dashboard-layout">{children}</div>,
}));
jest.mock("~/@/components/ownership/notice-feed-explorer", () => ({
  NoticeFeedExplorer: () => <div>notice feed stub</div>,
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/changes",
  useRouter: () => ({ replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import ChangesPage, { revalidate } from "./page";

describe("the changes page (spec 14.3, static ISR)", () => {
  beforeEach(() => {
    mockLoadFunds.mockReset();
    mockLoadFundPortfolio.mockReset();
    mockCompare.mockReset();
    mockBail.mockClear();
  });

  it("is static ISR for an hour, and takes no search parameter", () => {
    expect(revalidate).toBe(3600);
    expect(ChangesPage.length).toBe(0);
  });

  it("compares the default index fund's two newest files, and names its two tabs", async () => {
    mockLoadFunds.mockResolvedValue({
      ok: true,
      error: "",
      funds: [
        { key: "VAS", ticker: "VAS", name: "Vanguard", sourceKind: "etf", snapshotCount: 2 },
        { key: "HVST", ticker: "HVST", name: "Hostplus", sourceKind: "super_phd", snapshotCount: 1 },
      ],
    });
    mockLoadFundPortfolio.mockResolvedValue({
      ok: true,
      missing: false,
      error: "",
      fund: { snapshotDates: ["2026-09-30", "2026-10-31"] },
    });
    mockCompare.mockResolvedValue({ ok: true, from: "2026-09-30", to: "2026-10-31", sourceFrom: "", sourceTo: "", rows: [] });
    render(await ChangesPage());
    expect(mockLoadFundPortfolio).toHaveBeenCalledWith({ fundKey: "VAS" });
    expect(mockCompare).toHaveBeenCalledWith({ fundKey: "VAS", from: "2026-09-30", to: "2026-10-31" });
    expect(screen.getByRole("heading", { level: 1, name: "What changed?" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Fund snapshots",
      "Substantial notices",
    ]);
  });

  it("opens on the first index fund with two file dates, lists its rows, and orders the Fund select", async () => {
    mockLoadFunds.mockResolvedValue({
      ok: true,
      error: "",
      funds: [
        { key: "asx:VAS", ticker: "VAS", name: "Vanguard", sourceKind: "etf", snapshotCount: 1 },
        { key: "asx:IOZ", ticker: "IOZ", name: "iShares", sourceKind: "etf", snapshotCount: 3 },
        { key: "asx:A200", ticker: "A200", name: "Betashares", sourceKind: "etf", snapshotCount: 2 },
      ],
    });
    const DATES: Record<string, string[]> = {
      "asx:VAS": ["2026-10-15"],
      "asx:IOZ": ["2026-08-31", "2026-09-30", "2026-10-31"],
      "asx:A200": ["2026-09-30", "2026-10-31"],
    };
    mockLoadFundPortfolio.mockImplementation(async ({ fundKey }: { fundKey: string }) => ({
      ok: true,
      missing: false,
      error: "",
      fund: { snapshotDates: DATES[fundKey] ?? [] },
    }));
    mockCompare.mockResolvedValue({
      ok: true,
      error: "",
      from: "2026-09-30",
      to: "2026-10-31",
      sourceFrom: "",
      sourceTo: "",
      rows: [
        { code: "CBA", name: "Commonwealth Bank", industry: "Banks", weightFrom: 10, weightTo: 10.2, deltaPp: 0.2, valueFrom: null, valueTo: null, status: "continuing" },
      ],
    });
    render(await ChangesPage());
    // IOZ is the first index fund with two files; its two newest files are compared.
    expect(mockLoadFundPortfolio).toHaveBeenCalledWith({ fundKey: "asx:IOZ" });
    expect(mockCompare).toHaveBeenCalledWith({ fundKey: "asx:IOZ", from: "2026-09-30", to: "2026-10-31" });
    expect(screen.getByRole("link", { name: "CBA" })).toBeInTheDocument();
    expect(screen.queryByText("Two file dates of this fund are needed to compare them.")).not.toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: /^Fund/ });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "IOZ · iShares",
      "A200 · Betashares",
      "VAS · Vanguard (one file)",
    ]);
    expect(select).toHaveValue("asx:IOZ");
  });

  it("bails an outage of the funds read rather than caching an empty comparison", async () => {
    mockLoadFunds.mockResolvedValue({ ok: false, error: "", funds: [] });
    render(await ChangesPage());
    expect(mockBail).toHaveBeenCalled();
  });
});
