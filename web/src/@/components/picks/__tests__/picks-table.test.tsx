import { render, screen, within } from "@testing-library/react";

import {
  BASE_COLUMN_COUNT,
  PicksTable,
  RuleDots,
  RuleLegend,
  StatusPill,
} from "../picks-table";
import { pickGrowthFigures, pickRatioLines } from "../pick-fundamentals";
import {
  GrowthFigureView,
  growthFigures,
} from "~/@/components/stocks/growth-figures";
import { growth } from "~/@/components/stocks/__tests__/fixtures";
import { formatGrowthPct } from "~/@/lib/fundamentals/format";
import { SETUP, TRIGGERED, WATCH, ZANGER, pick } from "./fixtures";

const RULES = ZANGER.rules.map((rule) => ({ id: rule.id, title: rule.title }));

function renderTable(
  props: Partial<React.ComponentProps<typeof PicksTable>> = {},
) {
  return render(
    <PicksTable
      rows={[TRIGGERED, SETUP, WATCH]}
      rules={RULES}
      caption="Zanger Breakout Strategy: ranked ASX picks"
      showFundamentals
      {...props}
    />,
  );
}

function rowFor(code: string): HTMLElement {
  const row = screen.getByRole("link", { name: code }).closest("tr");
  if (!row) throw new Error(`no row for ${code}`);
  return row;
}

describe("PicksTable growth cells", () => {
  it("shows each figure with its basis tag, and marks a figure from a company filing", () => {
    renderTable();
    const cells = within(rowFor("BHP")).getAllByRole("cell");
    const revenue = cells.find((cell) =>
      cell.textContent?.startsWith("+41.2%"),
    )!;
    const eps = cells.find((cell) => cell.textContent?.startsWith("+22.5%"))!;

    expect(within(revenue).getByText("FY")).toBeInTheDocument();
    expect(revenue).toHaveAttribute("title", "Year to 30 Jun 2026");
    expect(within(revenue).queryByText(/source:/)).not.toBeInTheDocument();

    expect(within(eps).getByText("HY")).toBeInTheDocument();
    expect(eps).toHaveAttribute("title", "Half year to 31 Dec 2025");
    // The mark is never colour alone: a glyph plus screen-reader text.
    expect(within(eps).getByText("F")).toBeInTheDocument();
    expect(
      within(eps).getByText(/\(source: Company filing \(extracted\)\)/),
    ).toBeInTheDocument();
  });

  it("shows growth beyond the displayed range as n/m, with the raw figure in the title", () => {
    render(
      <PicksTable
        rows={[
          pick({
            code: "ZIP",
            revenueYoyPct: 812.4,
            epsYoyPct: -99,
            fundamentals: {
              revenueBasis: "ttm",
              revenueEnd: "2026-06-30",
              epsBasis: "annual",
            },
          }),
        ]}
        rules={RULES}
        caption="c"
        showFundamentals
      />,
    );
    const cells = within(rowFor("ZIP")).getAllByRole("cell");
    const nm = cells.filter((cell) => cell.textContent?.startsWith("n/m"));
    expect(nm).toHaveLength(2);
    expect(nm[0]).toHaveAttribute(
      "title",
      `12 months to 30 Jun 2026. ${formatGrowthPct(812.4).title}`,
    );
    expect(within(nm[0]!).getByText("TTM")).toBeInTheDocument();
    expect(screen.queryByText("+812.4%")).not.toBeInTheDocument();
  });

  // An API without StrategyPick.fundamentals sent no basis: the cell reads as
  // it always did, never with a guessed "FY".
  it("renders a row without fundamentals as before: no basis tag, no mark", () => {
    renderTable({
      rows: [SETUP, pick({ code: "OLD", fundamentals: undefined })],
    });
    const cells = within(rowFor("OLD")).getAllByRole("cell");
    const revenue = cells.find((cell) => cell.textContent === "+41.2%");
    expect(revenue).toBeDefined();
    expect(revenue).not.toHaveAttribute("title");
  });
});

// The stock page's growth row and the picker's growth cells state the SAME
// figures with the SAME labels (docs/plans/fundamentals-coverage.md §7.1): one
// growth fixture, rendered through both.
describe("growth figures: picker cells and the stock page's growth row agree", () => {
  const stockGrowth = growth({
    revenueBasisPeriodType: "ttm",
    revenueYoyPct: 812.4,
    revenueLatestPeriodEnd: "2026-06-30",
    revenueBasisSource: "vendor",
    basisPeriodType: "half",
    latestPeriodEnd: "2025-12-31",
    epsYoyPct: -17.26,
    epsBasisSource: "filing",
  });
  const pickRow = pick({
    code: "EDV",
    revenueYoyPct: 812.4,
    epsYoyPct: -17.26,
    fundamentals: {
      revenueBasis: "ttm",
      revenueEnd: "2026-06-30",
      epsBasis: "half",
      epsEnd: "2025-12-31",
      epsFiling: true,
    },
  });

  it("produces identical figures", () => {
    expect(pickGrowthFigures(pickRow)).toEqual(growthFigures(stockGrowth));
  });

  it("renders identical text", () => {
    const [stockRevenue, stockEps] = growthFigures(stockGrowth);
    const { container: stock } = render(
      <dl>
        <GrowthFigureView figure={stockRevenue!} />
        <GrowthFigureView figure={stockEps!} />
      </dl>,
    );
    const stockText = Array.from(stock.querySelectorAll("dd")).map(
      (dd) => dd.textContent,
    );

    render(
      <PicksTable
        rows={[pickRow]}
        rules={RULES}
        caption="c"
        showFundamentals
      />,
    );
    const cells = within(rowFor("EDV")).getAllByRole("cell");
    const pickerText = cells
      .filter(
        (cell) =>
          cell.textContent?.startsWith("n/m") ||
          cell.textContent?.startsWith("−17.3%"),
      )
      .map((cell) => cell.textContent);

    expect(pickerText).toEqual(stockText);
    expect(pickerText).toEqual([
      "n/mTTM",
      "−17.3%HYF (source: Company filing (extracted))",
    ]);
  });
});

describe("PicksTable fundamentals disclosure", () => {
  it("lists the ratios the row holds, the basis, the period, the filing source and the fetch date", () => {
    renderTable();
    const row = within(rowFor("BHP"));
    const details = rowFor("BHP").querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Fundamentals").tagName).toBe("SUMMARY");

    const list = details.querySelector("dl")!;
    const pairs = Array.from(list.querySelectorAll("dt")).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(pairs).toEqual([
      ["Net margin", "18.2%"],
      ["ROE", "21.4%"],
      ["FCF margin", "9.1%"],
      ["Net debt / EBITDA", "0.4×"],
      ["P/E", "14.2×"],
      ["Revenue growth", "Year to 30 Jun 2026"],
      ["EPS growth", "Half year to 31 Dec 2025, company filing (extracted)"],
      ["Fetched", "27 Sep 2026"],
    ]);

    const full = within(details).getByRole("link", { name: "Full financials" });
    expect(full).toHaveAttribute("href", "/shorts/BHP/financials");
    expect(full).toHaveAttribute("rel", "nofollow");
    // The code link stays the canonical stock URL.
    expect(row.getByRole("link", { name: "BHP" })).toHaveAttribute(
      "href",
      "/shorts/BHP",
    );
  });

  it("says why P/E is absent for a non-AUD reporter and leaves unheld ratios out", () => {
    renderTable();
    const details = rowFor("LTR").querySelector("details")!;
    const terms = Array.from(details.querySelectorAll("dt")).map(
      (dt) => dt.textContent,
    );
    expect(terms).toEqual([
      "Net margin",
      "P/E",
      "Revenue growth",
      "EPS growth",
      "Fetched",
    ]);
    expect(
      within(details).getByText("n/a (reports in USD)"),
    ).toBeInTheDocument();
    expect(within(details).getByText("−4.3%")).toBeInTheDocument();
  });

  it("marks ratios withheld for a financial as n/m, with the reason in the title", () => {
    const bank = pick({
      code: "CBA",
      fundamentals: {
        netMarginPct: 34.1,
        roePct: 13.6,
        peRatio: 26.4,
        notMeaningful: ["fcf_margin_pct", "net_debt_to_ebitda"],
      },
    });
    expect(
      pickRatioLines(bank.fundamentals!).map((l) => [l.label, l.value.text]),
    ).toEqual([
      ["Net margin", "34.1%"],
      ["ROE", "13.6%"],
      ["FCF margin", "n/m"],
      ["Net debt / EBITDA", "n/m"],
      ["P/E", "26.4×"],
    ]);
    render(
      <PicksTable rows={[bank]} rules={RULES} caption="c" showFundamentals />,
    );
    const nm = within(rowFor("CBA").querySelector("details")!).getAllByText(
      "n/m",
    );
    expect(nm).toHaveLength(2);
    for (const el of nm) {
      expect(el).toHaveAttribute(
        "title",
        "Not meaningful for banks, insurers and other financials",
      );
    }
  });

  it("says so when the API holds no fundamentals for the stock", () => {
    renderTable();
    const details = rowFor("PLS").querySelector("details")!;
    expect(
      within(details).getByText("No fundamentals held for PLS yet."),
    ).toBeInTheDocument();
    expect(within(details).queryByRole("link")).not.toBeInTheDocument();
  });

  // Absent is not a status: an API that does not report fundamentals gets
  // the table it always had, never "No fundamentals held".
  it("renders no disclosure at all when fundamentals are not reported", () => {
    renderTable({ showFundamentals: false });
    expect(document.querySelector("details")).toBeNull();
    expect(screen.queryByText(/No fundamentals held/)).not.toBeInTheDocument();
  });
});

describe("PicksTable sorted-by column", () => {
  it("adds one right-aligned column for a metric the table has no column for", () => {
    renderTable({ sortKey: "roe" });
    const header = screen.getByRole("columnheader", { name: "Sorted by ROE" });
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(header.className).toContain("text-right");
    expect(screen.getAllByRole("columnheader")).toHaveLength(
      BASE_COLUMN_COUNT + 1,
    );

    const last = (code: string) =>
      within(rowFor(code)).getAllByRole("cell").at(-1)!;
    expect(last("BHP")).toHaveTextContent("21.4%");
    expect(last("PLS")).toHaveTextContent("n/a");
  });

  it("shows P/E ascending, with the non-AUD reason, and market cap in AUD", () => {
    const { unmount } = renderTable({ sortKey: "pe" });
    expect(
      screen.getByRole("columnheader", { name: "Sorted by P/E" }),
    ).toHaveAttribute("aria-sort", "ascending");
    const last = (code: string) =>
      within(rowFor(code)).getAllByRole("cell").at(-1)!;
    expect(last("BHP")).toHaveTextContent("14.2×");
    expect(last("LTR")).toHaveTextContent("n/a (reports in USD)");
    unmount();

    renderTable({ sortKey: "market_cap" });
    expect(within(rowFor("BHP")).getAllByRole("cell").at(-1)).toHaveTextContent(
      "$1.20B",
    );
    // The header says which figure the column (and the sort) reads.
    expect(
      within(
        screen.getByRole("columnheader", { name: "Sorted by Market cap" }),
      ).getByText("Market cap"),
    ).toHaveAttribute(
      "title",
      "Latest close x shares on issue, in AUD; the screener's figure where we hold no share count",
    );
  });

  it("marks, rather than adds, a column the table already has, and shows it at every width", () => {
    renderTable({ sortKey: "eps_yoy" });
    expect(screen.getAllByRole("columnheader")).toHaveLength(BASE_COLUMN_COUNT);
    const eps = screen.getByRole("columnheader", { name: "EPS YoY" });
    expect(eps).toHaveAttribute("aria-sort", "descending");
    expect(eps.className).not.toContain("hidden");
    expect(
      screen.getByRole("columnheader", { name: "Rev YoY" }).className,
    ).toContain("hidden");
  });

  it("spans every column, the added one included, with the empty message", () => {
    const { unmount } = renderTable({ rows: [] });
    expect(screen.getByRole("cell")).toHaveAttribute(
      "colSpan",
      String(BASE_COLUMN_COUNT),
    );
    unmount();
    renderTable({ rows: [], sortKey: "net_margin" });
    expect(screen.getByRole("cell")).toHaveAttribute(
      "colSpan",
      String(BASE_COLUMN_COUNT + 1),
    );
  });

  it("dims the rows and marks the region busy while a sort loads", () => {
    const { container } = renderTable({ busy: true });
    const region = container.firstElementChild!;
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region.className).toContain("opacity-50");
  });
});

describe("header tooltips", () => {
  it("explain the basis tags and the filing mark on the growth columns", () => {
    renderTable();
    expect(screen.getByText("Rev YoY")).toHaveAttribute(
      "title",
      expect.stringContaining(
        "TTM: trailing 12 months; FY: full year; HY: half year",
      ),
    );
    expect(screen.getByText("EPS YoY")).toHaveAttribute(
      "title",
      expect.stringContaining("F marks a figure from a company filing"),
    );
  });
});

// The stock page's Strategy fit card imports these three with these props.
describe("exports shared with the stock page", () => {
  it("keeps StatusPill, RuleDots and RuleLegend hook-free with their props", () => {
    render(
      <>
        <StatusPill status="setup" />
        <RuleDots
          rules={[{ id: "roe", title: "High return on equity" }]}
          results={[
            { ruleId: "roe", status: "unknown", detail: "No equity figure" },
          ]}
        />
        <RuleLegend rules={[]} />
      </>,
    );
    expect(screen.getByText("Setup")).toBeInTheDocument();
    expect(
      screen.getByText("1. High return on equity: unknown. No equity figure"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Unknown (data missing, or not meaningful for this company)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Dots follow the rule order/),
    ).not.toBeInTheDocument();
  });
});
