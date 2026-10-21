import { render, screen, within } from "@testing-library/react";
import type {
  GetStockOwnershipResponse,
  KindShare,
  OwnershipStock,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { KindBar, NoticeTable, OwnershipStockTable } from "../ownership-parts";
import { StockOwnershipView } from "../stock-ownership-view";
import {
  formLabel,
  formatPointChange,
  formatVotingPower,
  fundLabel,
  institutionHref,
  kindInfo,
} from "~/@/lib/ownership/kinds";

const share = (kind: string, pct: number, holders = 1): KindShare =>
  ({ kind, pct, holders }) as unknown as KindShare;

const stock = (over: Partial<OwnershipStock> = {}): OwnershipStock =>
  ({
    stockCode: "PLS",
    companyName: "PLS Group",
    industry: "Materials",
    holders: 3,
    disclosedPct: 23.6,
    byKind: [share("hedge_fund", 6), share("active_manager", 5.5), share("corporate", 12.1)],
    shortPct: 12.9,
    hasShortPct: true,
    indexPct: 3.01,
    hasIndexPct: true,
    superOptions: 11,
    superValueAud: 579467732,
    hasSuperValue: true,
    marketCap: 0,
    hasMarketCap: false,
    ...over,
  }) as unknown as OwnershipStock;

const notice = (over: Partial<SubstantialNotice> = {}): SubstantialNotice =>
  ({
    stockCode: "ZIP",
    companyName: "Zip Co",
    holderKey: "australian-retirement-trust",
    holderName: "Australian Retirement Trust Pty Ltd",
    institutionSlug: "australian-retirement-trust",
    kind: "super_fund",
    form: "604",
    presentPct: 6.2,
    hasPresent: true,
    previousPct: 5.045,
    hasPrevious: true,
    ceased: false,
    eventDate: "2026-10-14",
    announcedOn: "2026-10-16",
    announcementUrl: "https://www.asx.com.au/x.pdf",
    ...over,
  }) as unknown as SubstantialNotice;

describe("ownership vocabulary", () => {
  it("names forms by what happened", () => {
    expect(formLabel("603", false)).toBe("Became substantial");
    expect(formLabel("604", false)).toBe("Changed");
    expect(formLabel("605", true)).toBe("Ceased");
    expect(formLabel("604", true)).toBe("Ceased");
  });

  it("prints voting power as the notice states it and changes in points with a true minus", () => {
    expect(formatVotingPower(5.045)).toBe("5.045%");
    expect(formatVotingPower(5.2988)).toBe("5.2988%");
    expect(formatVotingPower(6.2)).toBe("6.20%");
    expect(formatVotingPower(undefined)).toBe("n/a");
    expect(formatPointChange(5.045, 6.2)).toBe("+1.16 pp");
    expect(formatPointChange(7.45, 6.4)).toBe("−1.05 pp");
    expect(formatPointChange(6.4, 6.4)).toBe("0.00 pp");
  });

  it("never colours a kind red or green", () => {
    for (const kind of ["super_fund", "hedge_fund", "bank_broker", "corporate", "unclassified"]) {
      expect(kindInfo(kind).swatch).not.toMatch(/red|green|emerald/);
    }
    expect(kindInfo("not-a-kind").label).toBe("Unclassified");
  });

  it("names a fund with its code once", () => {
    expect(fundLabel("VAS", "Vanguard Australian Shares Index Fund (VAS)")).toBe(
      "Vanguard Australian Shares Index Fund (VAS)",
    );
    expect(fundLabel("IOZ", "iShares Core S&P/ASX 200 ETF")).toBe("IOZ, iShares Core S&P/ASX 200 ETF");
    expect(fundLabel("", "Balanced")).toBe("Balanced");
  });

  it("links only institutions on the map", () => {
    expect(institutionHref("vanguard")).toBe("/ownership/vanguard");
    expect(institutionHref("")).toBeNull();
  });
});

describe("KindBar", () => {
  it("scales a register whose notices sum past 100% to fit, and says each kind's share", () => {
    const { container } = render(<KindBar byKind={[share("index_manager", 80), share("bank_broker", 40)]} />);
    const segments = container.querySelectorAll("span[aria-hidden]");
    expect(segments).toHaveLength(2);
    const widths = Array.from(segments).map((s) => (s as HTMLElement).style.width);
    expect(widths).toEqual([`${(80 * 100) / 120}%`, `${(40 * 100) / 120}%`]);
    expect(screen.getByText("Index manager 80.00%, Bank or broker 40.00%")).toBeInTheDocument();
  });

  it("prints sums to two decimals so a column lines up", () => {
    render(<OwnershipStockTable stocks={[stock({ byKind: [share("index_manager", 45.2308)] })]} columns={["institutional"]} caption="x" />);
    expect(screen.getByText("45.23%")).toBeInTheDocument();
  });
});

describe("OwnershipStockTable", () => {
  it("counts only institutions in the institutional column, and prints short interest", () => {
    render(
      <OwnershipStockTable stocks={[stock()]} columns={["institutional", "holders", "short"]} caption="Crowded" />,
    );
    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["PLSPLS Group", "11.50%", "3", "12.90%"]);
    expect(within(cells[0]!).getByRole("link", { name: "PLS" })).toHaveAttribute("href", "/shorts/PLS/company");
  });

  it("says so when a view has no stocks", () => {
    render(<OwnershipStockTable stocks={[]} columns={["index"]} caption="Passive" />);
    expect(screen.getByText("No stocks meet this view yet.")).toBeInTheDocument();
  });
});

describe("NoticeTable", () => {
  it("lists a change with its previous figure, and a ceasing without one", () => {
    render(
      <NoticeTable
        notices={[notice(), notice({ form: "605", ceased: true, hasPresent: false, hasPrevious: false, announcementUrl: "u2" })]}
        caption="Notices"
      />,
    );
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "2026-10-16",
      "ZIP",
      "Australian Retirement Trust Pty Ltd",
      "Changed",
      "6.20%",
      "+1.16 pp",
      "",
    ]);
    expect(within(rows[2]!).getByText("Ceased")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("under 5%")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("link", { name: "Australian Retirement Trust Pty Ltd" })).toHaveAttribute(
      "href",
      "/ownership/australian-retirement-trust",
    );
  });
});

describe("HolderName in a notice", () => {
  it("links a listed-company holder to its own stock page, and leaves a private holder unlinked", () => {
    render(
      <NoticeTable
        notices={[
          notice({ holderKey: "asx:SFR", holderName: "Sandfire Resources Limited", institutionSlug: "", kind: "corporate" }),
          notice({ holderKey: "name:wesley jon maas", holderName: "Wesley Jon Maas", institutionSlug: "", announcementUrl: "u3" }),
        ]}
        caption="Notices"
      />,
    );
    expect(screen.getByRole("link", { name: "Sandfire Resources Limited" })).toHaveAttribute(
      "href",
      "/shorts/SFR/company",
    );
    expect(screen.queryByRole("link", { name: "Wesley Jon Maas" })).toBeNull();
  });
});

describe("StockOwnershipView", () => {
  const data = {
    summary: stock({ stockCode: "ZIP", byKind: [share("super_fund", 6.2)], disclosedPct: 6.2, holders: 1 }),
    holders: [
      {
        stockCode: "ZIP",
        holderKey: "australian-retirement-trust",
        holderName: "Australian Retirement Trust Pty Ltd",
        institutionSlug: "australian-retirement-trust",
        kind: "super_fund",
        form: "604",
        votingPowerPct: 6.2,
        previousPct: 5.045,
        hasPrevious: true,
        eventDate: "",
        announcedOn: "2026-10-16",
        announcementUrl: "https://www.asx.com.au/x.pdf",
      },
    ],
    history: [],
    fundHoldings: [
      {
        institutionSlug: "vanguard",
        institutionName: "Vanguard",
        kind: "index_manager",
        fundName: "Vanguard Australian Shares Index Fund (VAS)",
        fundCode: "VAS",
        sourceKind: "etf",
        asAt: "2026-09-30",
        stockCode: "ZIP",
        units: 2e7,
        hasUnits: true,
        valueAud: 6.4e7,
        hasValue: true,
        weightPct: 0.12,
        hasWeight: true,
        pctOfIssued: 1.54,
        hasPctOfIssued: true,
      },
      {
        institutionSlug: "rest",
        institutionName: "Rest",
        kind: "super_fund",
        fundName: "Growth",
        sourceKind: "super_phd",
        asAt: "2026-06-30",
        stockCode: "ZIP",
        valueAud: 2.97e6,
        hasValue: true,
        // Super disclosures state weights to two decimals: a real holding reads 0.00.
        weightPct: 0,
        hasWeight: true,
        pctOfIssued: 0.07,
        hasPctOfIssued: true,
      },
    ],
    sharesOnIssue: 1.3e9,
    hasSharesOnIssue: true,
  } as unknown as GetStockOwnershipResponse;

  it("lists the holder with its change and the fund with its share of the company", () => {
    render(<StockOwnershipView data={data} />);
    expect(screen.getByRole("heading", { level: 3, name: "Who owns it" })).toBeInTheDocument();
    expect(screen.getByText(/1 substantial holder disclosing 6\.20%/)).toBeInTheDocument();
    const tables = screen.getAllByRole("table");
    expect(tables).toHaveLength(2);
    const holderCells = within(within(tables[0]!).getAllByRole("row")[1]!).getAllByRole("cell");
    expect(holderCells[2]!.textContent).toBe("6.20%");
    expect(holderCells[3]!.textContent).toBe("+1.16 pp");
    // No event date: the release date stands in.
    expect(holderCells[4]!.textContent).toBe("2026-10-16");
    const fundCells = within(within(tables[1]!).getAllByRole("row")[1]!).getAllByRole("cell");
    expect(fundCells[2]!.textContent).toBe("1.54%");
    expect(fundCells[3]!.textContent).toBe("0.12%");
    // A stated 0.00 beside a real value is a small holding, never none.
    const superCells = within(within(tables[1]!).getAllByRole("row")[2]!).getAllByRole("cell");
    expect(superCells[3]!.textContent).toBe("<0.01%");
    expect(screen.getByText(/index funds tracked hold/)).toBeInTheDocument();
  });
});
