import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  GetStockOwnershipResponse,
  KindShare,
  OwnershipStock,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { EXTERNAL_LINK_SYMBOL_ID, ExternalLinkSymbol } from "../external-link-glyph";
import { KindBadge as KindBadgeFromModule } from "../kind-badge";
import { NoticeTable } from "../notice-table";
import { KindBadge, OwnershipMethodology, OwnershipStockTable } from "../ownership-parts";
import { FileHoldingsTable, SubstantialHoldingsTable } from "../ownership-tables";
import { STOCK_FUND_HOLDINGS_SHOWN, StockOwnershipView } from "../stock-ownership-view";
import {
  INVESTOR_KINDS,
  asAtRange,
  formLabel,
  formatPointChange,
  formatVotingPower,
  fundLabel,
  holderHref,
  institutionHref,
  kindInfo,
  registerHref,
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

  it("sends every stock to its register page, whatever the case of its code", () => {
    expect(registerHref("bhp")).toBe("/ownership/stocks/BHP");
    expect(registerHref("PLS")).toBe("/ownership/stocks/PLS");
  });

  it("counts investors in a crowded register, and leaves banks and brokers out", () => {
    expect(INVESTOR_KINDS.has("super_fund")).toBe(true);
    expect(INVESTOR_KINDS.has("hedge_fund")).toBe(true);
    expect(INVESTOR_KINDS.has("bank_broker")).toBe(false);
  });

  it("dates a source by one date, or by the span its files cover", () => {
    expect(asAtRange("2026-10-14", "2026-10-14")).toBe("as at 2026-10-14");
    expect(asAtRange("2026-09-30", "2026-10-19")).toBe("as at 2026-09-30 to 2026-10-19");
    expect(asAtRange("", "")).toBe("as at n/a");
  });
});

describe("the disclosed bar in a stock table", () => {
  it("draws every bar against the table's largest sum, so the bars compare", () => {
    render(
      <OwnershipStockTable
        stocks={[
          stock({ stockCode: "PLS", disclosedPct: 23.6 }),
          stock({ stockCode: "ZIP", disclosedPct: 6.2, byKind: [share("super_fund", 6.2)] }),
        ]}
        columns={["bar"]}
        caption="Bars"
      />,
    );
    const [pls, zip] = screen.getAllByRole("img").map((bar) => (bar as HTMLElement).style.width);
    expect(pls).toBe("100%");
    expect(zip).toBe(`${(6.2 / 23.6) * 100}%`);
  });

  it("says what a bar discloses, without a figure, and never as a share of the company", () => {
    render(<OwnershipStockTable stocks={[stock()]} columns={["bar"]} caption="Bars" />);
    const bar = screen.getByRole("img", {
      name: /^Disclosed voting power 23\.60%, what the notices disclose and not a share of the company:/,
    });
    expect(bar.className).toContain("border-muted-foreground");
    expect(bar.className).not.toContain("border-input");
    expect(screen.queryByText("23.60%")).toBeNull();
  });
});

describe("OwnershipStockTable", () => {
  it("counts investors, not banks, in the institutional column, and prints short interest", () => {
    render(
      <OwnershipStockTable
        stocks={[stock({ byKind: [...stock().byKind, share("bank_broker", 4)] })]}
        columns={["institutional", "holders", "bank", "short"]}
        caption="Crowded"
      />,
    );
    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["PLSPLS Group", "11.50%", "3", "4.00%", "12.90%"]);
    expect(within(cells[0]!).getByRole("link", { name: "PLS" })).toHaveAttribute("href", "/ownership/stocks/PLS");
  });

  it("says so when a view has no stocks", () => {
    render(<OwnershipStockTable stocks={[]} columns={["index"]} caption="Passive" />);
    expect(screen.getByText("No stocks meet this view yet.")).toBeInTheDocument();
  });
});

describe("KindBadge", () => {
  it("is one badge on every surface, re-exported from its own module", () => {
    expect(KindBadge).toBe(KindBadgeFromModule);
  });
});

describe("OwnershipMethodology", () => {
  it("states the method in the words the copy fixes", () => {
    render(<OwnershipMethodology />);
    expect(
      screen.getByText(
        "Substantial holdings are the voting power stated in each holder's latest ASX notice (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF. A holding is shown until a later notice read says it changed or ceased; the date is the notice's, and \"current\" means the newest notice we could read. A notice whose voting power cannot be read unambiguously (a scanned form, a figure only in an annexure) is withheld, never estimated.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Holders' interests can overlap: MUFG reports Morgan Stanley's and First Sentier's interests as its own. Sums count each interest once where the overlap is known (a group and its member count the larger figure; two notices disclosing the same voting power on the same date count once), and every holder is still listed. Other overlaps remain, so a sum is what the notices disclose, not a share of the company. Banks' and brokers' notices are often securities lending, so crowded registers do not count them. A fall in voting power is a fall in the notice's figure, not necessarily a disposal: a placement dilutes a holder whose shares did not change.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Index fund holdings are the funds' own holdings files (Vanguard's are the pooled fund behind each ETF); super fund holdings are each fund's portfolio holdings disclosure for one investment option, not the whole fund. Short interest is ASIC's daily short position report. Not financial advice.",
      ),
    ).toBeInTheDocument();
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
      age: "",
      form: "Changed",
      url: `https://www.asx.com.au/${i}.pdf`,
    }));
  const files = (n: number): FileHoldingRow[] =>
    Array.from({ length: n }, (_, i) => ({
      code: `F${String(i).padStart(2, "0")}`,
      fund: "VAS, Vanguard Australian Shares Index Fund",
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
      "/ownership/stocks/F99",
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
    expect(within(table).getByRole("link", { name: "N29" })).toHaveAttribute("href", "/ownership/stocks/N29");
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
    summary: stock({
      stockCode: "ZIP",
      byKind: [share("super_fund", 6.2)],
      disclosedPct: 6.2,
      holders: 1,
      indexAsAtFrom: "2026-09-30",
      indexAsAtTo: "2026-10-19",
    }),
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
    withheldListed: 0,
    asOf: "",
  } as unknown as GetStockOwnershipResponse;

  it("reads its title and the sum its holders disclose, with the funds that hold it", () => {
    render(<StockOwnershipView data={data} />);
    expect(screen.getByRole("heading", { level: 3, name: "Substantial holders" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 holder, 1 interest counted once, disclose 6.20% between them; held by 1 index fund and 1 super option tracked (Vanguard's files are the pooled fund's)",
      ),
    ).toBeInTheDocument();
  });

  it("captions the disclosed bar, which runs the full width of the card", () => {
    render(<StockOwnershipView data={data} />);
    const bar = screen.getByRole("img", {
      name: /^Disclosed voting power 6\.20%, what the notices disclose and not a share of the company:/,
    });
    expect(bar.style.width).toBe("100%");
    expect(
      screen.getByText("What the notices disclose, each interest counted once; not a share of the company."),
    ).toBeInTheDocument();
  });

  it("lists the holder with its change, and the funds with their share of the company", () => {
    render(<StockOwnershipView data={data} />);
    const tables = screen.getAllByRole("table");
    expect(tables).toHaveLength(2);
    const holderCells = within(within(tables[0]!).getAllByRole("row")[1]!).getAllByRole("cell");
    expect(holderCells[2]!.textContent).toBe("6.20%");
    expect(holderCells[3]!.textContent).toBe("+1.16 pp");
    // No event date: the release date stands in.
    expect(holderCells[4]!.textContent).toBe("2026-10-16");

    // Fund rows: fund, source, value, of shares, of fund, as at. A stated 0.00
    // beside a real value is a small holding, never none.
    const [vas, growth] = within(tables[1]!)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell").map((c) => c.textContent));
    expect(vas!.slice(1)).toEqual(["Index fund file", fileHoldingRow(data.fundHoldings[0]!).value, "1.54%", "0.12%", "2026-09-30"]);
    expect(growth!.slice(1)).toEqual(["Super option", fileHoldingRow(data.fundHoldings[1]!).value, "0.07%", "<0.01%", "2026-06-30"]);
  });

  it("dates the index funds' share by the span its files cover", () => {
    render(<StockOwnershipView data={data} />);
    const suffix = screen.getByText(/index funds tracked hold/);
    expect(suffix).toHaveTextContent(
      "index funds tracked hold 3.01% of shares on issue (files as at 2026-09-30 to 2026-10-19)",
    );
    expect(suffix.querySelector("time")).toHaveAttribute("datetime", "2026-09-30");
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
        const [, , value, ofShares, ofFund, asAt] = within(row).getAllByRole("cell").map((c) => c.textContent);
        return { value, ofShares, ofFund, asAt };
      });
    expect(drawn).toEqual(
      data.fundHoldings.map((h) => {
        const { value, ofShares, ofFund, asAt } = fileHoldingRow(h);
        return { value, ofShares, ofFund, asAt };
      }),
    );
  });

  it("draws eight funds at most, and sends the rest to the register", () => {
    const funds = Array.from({ length: 10 }, (_, i) => ({
      ...data.fundHoldings[0]!,
      institutionSlug: `fund-${i}`,
      institutionName: `Fund ${i}`,
      fundName: `Index Fund ${i}`,
      fundCode: `F${i}`,
    }));
    render(<StockOwnershipView data={{ ...data, fundHoldings: funds } as unknown as GetStockOwnershipResponse} />);
    const drawn = within(screen.getAllByRole("table")[1]!).getAllByRole("row").slice(1);
    expect(drawn).toHaveLength(STOCK_FUND_HOLDINGS_SHOWN);
    expect(screen.getByRole("link", { name: "All 10 fund rows in the full register →" })).toHaveAttribute(
      "href",
      "/ownership/stocks/ZIP#funds",
    );
  });

  it("ages a holding no notice has refreshed for more than 90 days", () => {
    const aged = {
      ...data,
      asOf: "2026-10-16",
      holders: [{ ...data.holders[0]!, eventDate: "2026-01-10", announcedOn: "2026-01-12" }],
    } as unknown as GetStockOwnershipResponse;
    render(<StockOwnershipView data={aged} />);
    const holderCells = within(within(screen.getAllByRole("table")[0]!).getAllByRole("row")[1]!).getAllByRole("cell");
    expect(holderCells[4]!).toHaveTextContent("2026-01-10");
    expect(within(holderCells[4]!).getByText("9 mo")).toBeInTheDocument();
  });

  it("prints no age for a holding a notice refreshed within 90 days", () => {
    const recent = {
      ...data,
      asOf: "2026-10-16",
      holders: [{ ...data.holders[0]!, eventDate: "2026-10-14" }],
    } as unknown as GetStockOwnershipResponse;
    render(<StockOwnershipView data={recent} />);
    const holderCells = within(within(screen.getAllByRole("table")[0]!).getAllByRole("row")[1]!).getAllByRole("cell");
    expect(holderCells[4]!.textContent).toBe("2026-10-14");
  });

  it("reads a register with no current holder as none read, and still draws its funds", () => {
    render(<StockOwnershipView data={{ ...data, holders: [] } as unknown as GetStockOwnershipResponse} />);
    expect(
      screen.getByText(
        "No current substantial holder read for this stock; held by 1 index fund and 1 super option tracked",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("links every stock to its register page, and none to a Company tab", () => {
    const { container } = render(<StockOwnershipView data={data} />);
    expect(container.querySelectorAll('a[href^="/shorts/"]')).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Full register →" })).toHaveAttribute("href", "/ownership/stocks/ZIP");
  });

  it("closes with the method, the register, the disclaimer and an error report", () => {
    render(<StockOwnershipView data={data} />);
    expect(screen.getByRole("link", { name: "How ownership is read →" })).toHaveAttribute(
      "href",
      "/ownership#method",
    );
    expect(screen.getByRole("link", { name: "Not financial advice" })).toHaveAttribute("href", "/disclaimer");
    expect(screen.getByRole("link", { name: "Report an error" })).toHaveAttribute(
      "href",
      "mailto:support@shorted.com.au?subject=Ownership%20data%3A%20ZIP%20register",
    );
  });

  it("names the notices withheld under the stock in the footer, and never beside the sum", () => {
    const { rerender } = render(
      <StockOwnershipView data={{ ...data, withheldListed: 2 } as unknown as GetStockOwnershipResponse} />,
    );
    expect(screen.getByText(/2 notices listed under ZIP were withheld\./)).toBeInTheDocument();
    expect(screen.getByText(/^1 holder, 1 interest counted once/)).not.toHaveTextContent("withheld");

    rerender(<StockOwnershipView data={data} />);
    expect(screen.queryByText(/were withheld\./)).toBeNull();
  });
});
