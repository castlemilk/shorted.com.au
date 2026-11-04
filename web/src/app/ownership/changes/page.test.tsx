/// <reference types="jest" />

import { render, screen } from "@testing-library/react";

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
        { key: "VAS", ticker: "VAS", name: "Vanguard", sourceKind: "etf" },
        { key: "HVST", ticker: "HVST", name: "Hostplus", sourceKind: "super_phd" },
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

  it("bails an outage of the funds read rather than caching an empty comparison", async () => {
    mockLoadFunds.mockResolvedValue({ ok: false, error: "", funds: [] });
    render(await ChangesPage());
    expect(mockBail).toHaveBeenCalled();
  });
});
