import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  GetStockOwnershipResponse,
  KindShare,
  OwnershipStock,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { EXTERNAL_LINK_SYMBOL_ID, ExternalLinkSymbol } from "../external-link-glyph";
import { NoticeTable } from "../notice-table";
import { KindBar, OwnershipStockTable } from "../ownership-parts";
import { FileHoldingsTable, SubstantialHoldingsTable } from "../ownership-tables";
import { StockOwnershipView } from "../stock-ownership-view";
import {
  formLabel,
  formatPointChange,
  formatVotingPower,
  fundLabel,
  holderHref,
  institutionHref,
  kindInfo,
} from "~/@/lib/ownership/kinds";
import { fileHoldingRow, noticeRow, type FileHoldingRow, type HoldingRow } from "~/@/lib/ownership/rows";

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

  it("links a holder to its institution page, a listed holder to its stock, and nobody else", () => {
    expect(holderHref("vanguard", "vanguard")).toBe("/ownership/vanguard");
    expect(holderHref("", "asx:SFR")).toBe("/shorts/SFR/company");
    expect(holderHref("", "name:wesley jon maas")).toBeNull();
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

// The institution page's tables ran to every row the API returns (88 stakes,
// 100 holdings-file rows and 100 notices for Vanguard), each row drawn as
// HTML and again as an RSC element tree, with its own copy of the lucide
// icon: /ownership/vanguard weighed 946 KB. The islands send rows as data;
// only the notices are bounded.
describe("ownership table islands", () => {
  const holdings = (n: number): HoldingRow[] =>
    Array.from({ length: n }, (_, i) => ({
      code: `S${String(i).padStart(2, "0")}`,
      company: `Company ${i}`,
      votingPower: `${(20 - i / 10).toFixed(2)}%`,
      change: "",
      asAt: "2026-10-14",
      form: "Changed",
      url: `https://www.asx.com.au/${i}.pdf`,
    }));
  const files = (n: number): FileHoldingRow[] =>
    Array.from({ length: n }, (_, i) => ({
      code: `F${String(i).padStart(2, "0")}`,
      fund: "VAS, Vanguard Australian Shares Index ETF",
      value: "A$1.0b",
      ofFund: "1.00%",
      ofShares: "0.50%",
      asAt: "2026-10-19",
    }));
  const notices = (n: number) =>
    Array.from({ length: n }, (_, i) => notice({ stockCode: `N${String(i).padStart(2, "0")}`, announcementUrl: `u${i}` }));
  const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

  // What an institution holds is the page's promise: no holdings table hides
  // a row, or a stock link, behind a control.
  it("draws every stake and holdings-file row, in the server's order, with no control", () => {
    render(
      <>
        <SubstantialHoldingsTable rows={holdings(90)} holder="Vanguard" caption="Stakes" />
        <FileHoldingsTable rows={files(100)} caption="Files" />
      </>,
    );
    const stakes = screen.getByRole("table", { name: "Stakes" });
    expect(bodyRows(stakes)).toHaveLength(90);
    expect(within(stakes).getAllByRole("link", { name: /^S\d\d$/ }).map((a) => a.textContent)).toEqual(
      holdings(90).map((h) => h.code),
    );
    expect(within(screen.getByRole("table", { name: "Files" })).getByRole("link", { name: "F99" })).toHaveAttribute(
      "href",
      "/shorts/F99/company",
    );
    expect(bodyRows(screen.getByRole("table", { name: "Files" }))).toHaveLength(100);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws the newest notices and holds the rest behind Show all", () => {
    render(<NoticeTable notices={notices(30)} showHolder={false} caption="Notices" limit={25} />);
    const table = screen.getByRole("table", { name: "Notices" });
    expect(bodyRows(table)).toHaveLength(25);
    expect(within(table).getAllByRole("link", { name: /^N\d\d$/ }).map((a) => a.textContent)).toEqual(
      notices(25).map((n) => n.stockCode),
    );

    const more = screen.getByRole("button", { name: "Show all 30 notices" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveAttribute("aria-controls", table.querySelector("tbody")!.id);
    fireEvent.click(more);
    expect(bodyRows(table)).toHaveLength(30);
    expect(within(table).getByRole("link", { name: "N29" })).toHaveAttribute("href", "/shorts/N29/company");
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(bodyRows(table)).toHaveLength(25);
  });

  // GetInstitution serves a holder's newest 100 notices. "Show all 100
  // notices" beside a holder with 1,117 on record called a capped list whole.
  it("names the notices on record when the rows served are only the newest of them", () => {
    render(<NoticeTable notices={notices(100)} showHolder={false} caption="Capped" limit={25} onRecord={1117} />);
    render(<NoticeTable notices={notices(30)} showHolder={false} caption="Whole" limit={25} onRecord={30} />);

    const capped = screen.getByRole("button", { name: "Show the latest 100 of 1,117 notices" });
    expect(capped).toHaveAttribute("aria-controls", screen.getByRole("table", { name: "Capped" }).querySelector("tbody")!.id);
    expect(screen.getByRole("button", { name: "Show all 30 notices" })).toHaveAttribute(
      "aria-controls",
      screen.getByRole("table", { name: "Whole" }).querySelector("tbody")!.id,
    );
    fireEvent.click(capped);
    expect(bodyRows(screen.getByRole("table", { name: "Capped" }))).toHaveLength(100);
  });

  it("draws every notice, and no control, within the limit or without one", () => {
    render(<NoticeTable notices={notices(25)} caption="Within" limit={25} />);
    expect(bodyRows(screen.getByRole("table", { name: "Within" }))).toHaveLength(25);
    expect(screen.queryByRole("button")).toBeNull();

    render(<NoticeTable notices={notices(30)} caption="Latest" />);
    expect(bodyRows(screen.getByRole("table", { name: "Latest" }))).toHaveLength(30);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("points every ASX link at the page's one external-link symbol, with a label", () => {
    const { container } = render(
      <>
        <ExternalLinkSymbol />
        <SubstantialHoldingsTable rows={holdings(3)} holder="Vanguard" caption="Stakes" />
        <NoticeTable notices={[notice()]} caption="Notices" />
      </>,
    );
    expect(container.querySelectorAll(`symbol#${EXTERNAL_LINK_SYMBOL_ID}`)).toHaveLength(1);
    const asx = screen.getAllByRole("link", { name: /on ASX$/ });
    expect(asx.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Vanguard's S00 notice on ASX",
      "Vanguard's S01 notice on ASX",
      "Vanguard's S02 notice on ASX",
      "Notice for ZIP, released 2026-10-16, on ASX",
    ]);
    for (const a of asx) {
      expect(a.querySelector("use")).toHaveAttribute("href", `#${EXTERNAL_LINK_SYMBOL_ID}`);
    }
    expect(container.querySelector("svg.lucide")).toBeNull();
  });

  it("leaves the holder out of a notice row where the table names none", () => {
    expect(noticeRow(notice(), false)).not.toHaveProperty("holder");
    expect(noticeRow(notice(), true).holder).toEqual({
      name: "Australian Retirement Trust Pty Ltd",
      href: "/ownership/australian-retirement-trust",
    });
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

  // The institution page's holdings-file island prints rows formatted apart
  // from this card (lib/ownership/rows.ts), so a holding can read one way here
  // and another there: Rest's 0.00 was "<0.01%" on this card and "0.00%" on
  // /ownership/rest.
  it("reads each fund holding as the institution page's holdings-file rows do", () => {
    render(<StockOwnershipView data={data} />);
    const drawn = within(screen.getAllByRole("table")[1]!)
      .getAllByRole("row")
      .slice(1)
      .map((row) => {
        const [, value, ofShares, ofFund, asAt] = within(row).getAllByRole("cell").map((c) => c.textContent);
        return { value, ofShares, ofFund, asAt };
      });
    expect(drawn).toEqual(
      data.fundHoldings.map((h) => {
        const { value, ofShares, ofFund, asAt } = fileHoldingRow(h);
        return { value, ofShares, ofFund, asAt };
      }),
    );
  });
});
