/// <reference types="jest" />

/**
 * The index fund window's view (spec 13.5). The lists are the ten rises and ten
 * falls by weight, and a stock held on one date only sits in New or Dropped with
 * no change drawn. The caption is the spec's, verbatim. Every figure is a figure
 * the file states, and an AUD change is marked estimated.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";

import type { FundPositionChangesPage, FundSeriesRow } from "~/app/actions/ownershipDesk";
import { formatAmount } from "~/@/lib/fundamentals/format";
import type { FundChangeRow } from "../fund-changes";
import {
  FUND_POSITIONS_CAPTION,
  FUND_POSITIONS_OUTAGE,
  FundPositionsView,
  FundStockPanel,
  fundPositionLists,
  formatValueChange,
  valueChange,
} from "../fund-positions-static";

const DATES = ["2026-08-31", "2026-09-30", "2026-10-31"];

function row(over: Partial<FundChangeRow> & { code: string }): FundChangeRow {
  return {
    name: `${over.code} Ltd`,
    weightFrom: 5,
    weightTo: 5,
    delta: 0,
    valueFrom: 1_000_000_000,
    valueTo: 1_000_000_000,
    funds: 2,
    state: "current",
    ...over,
  };
}

const ROWS: FundChangeRow[] = [
  row({ code: "BHP", weightFrom: 5, weightTo: 6.5, delta: 1.5, valueFrom: 1_000_000_000, valueTo: 1_012_000_000 }),
  row({ code: "CBA", weightFrom: 4, weightTo: 3, delta: -1, valueFrom: 800_000_000, valueTo: 600_000_000 }),
  row({ code: "WES", weightFrom: null, weightTo: 0.8, delta: null, valueFrom: null, valueTo: 50_000_000, state: "new", funds: 1 }),
  row({ code: "ORG", weightFrom: 0.4, weightTo: null, delta: null, valueFrom: 20_000_000, valueTo: null, state: "dropped", funds: 1 }),
];

function page(over: Partial<FundPositionChangesPage> = {}): FundPositionChangesPage {
  return {
    ok: true,
    error: "",
    snapshotDates: DATES,
    from: "2026-09-30",
    to: "2026-10-31",
    rows: ROWS,
    ...over,
  };
}

describe("fundPositionLists", () => {
  it("sorts the rises and falls by size, keeps new and dropped apart, and never draws a change from zero", () => {
    const lists = fundPositionLists(ROWS);
    expect(lists.rises.map((r) => r.code)).toEqual(["BHP"]);
    expect(lists.falls.map((r) => r.code)).toEqual(["CBA"]);
    expect(lists.added.map((r) => r.code)).toEqual(["WES"]);
    expect(lists.dropped.map((r) => r.code)).toEqual(["ORG"]);
  });

  it("caps each list at ten rows", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row({ code: `R${String(i).padStart(2, "0")}`, delta: 1 + i * 0.1, weightFrom: 1, weightTo: 2 }),
    );
    expect(fundPositionLists(many).rises).toHaveLength(10);
  });
});

describe("valueChange", () => {
  it("is the later value less the earlier, and null when either date has none", () => {
    expect(valueChange(ROWS[0]!)).toBe(12_000_000);
    expect(valueChange(ROWS[2]!)).toBeNull();
    expect(valueChange(ROWS[3]!)).toBeNull();
  });
});

describe("formatValueChange", () => {
  it("writes a rise with a plus and a fall with the true minus, and n/a without a figure", () => {
    expect(formatValueChange(12_000_000)).toBe(`+${formatAmount(12_000_000, "AUD")}`);
    expect(formatValueChange(-200_000_000)).toBe(formatAmount(-200_000_000, "AUD"));
    expect(formatValueChange(-200_000_000)).toContain("−");
    expect(formatValueChange(null)).toBe("n/a");
  });
});

describe("FundPositionsView", () => {
  it("prints the spec's caption verbatim, and the range as from and to", () => {
    render(<FundPositionsView page={page()} />);
    expect(screen.getByText(FUND_POSITIONS_CAPTION)).toBeInTheDocument();
    expect(FUND_POSITIONS_CAPTION).toBe(
      "Index fund holdings files, one snapshot per file date; a weight is the fund's, not a share of the company. Super options disclose semi-annually.",
    );
    expect(screen.getByText("From 2026-09-30 to 2026-10-31")).toBeInTheDocument();
  });

  it("lists rises and falls with their change in points and the AUD change marked estimated, and New and Dropped with one weight each", () => {
    render(<FundPositionsView page={page()} />);
    expect(screen.getAllByText("AUD change, estimated", { exact: false }).length).toBeGreaterThan(0);
    const rises = screen.getByRole("heading", { name: "Rises in weight" }).closest("div")!.parentElement!;
    expect(within(rises).getByText("+1.50 pp")).toBeInTheDocument();
    expect(within(rises).getByText(`+${formatAmount(12_000_000, "AUD")}`)).toBeInTheDocument();
    const falls = screen.getByRole("heading", { name: "Falls in weight" }).closest("div")!.parentElement!;
    expect(within(falls).getByText("−1.00 pp")).toBeInTheDocument();

    const added = screen.getByRole("heading", { name: "New" }).closest("div")!.parentElement!;
    expect(within(added).getByText("0.80%")).toBeInTheDocument();
    expect(within(added).queryByText(/\bpp\b/)).toBeNull();
    const dropped = screen.getByRole("heading", { name: "Dropped" }).closest("div")!.parentElement!;
    expect(within(dropped).getByText("0.40%")).toBeInTheDocument();
    expect(within(dropped).queryByText(/\bpp\b/)).toBeNull();
  });

  it("gives its table every row with n/a where a date has no weight, and never a change from zero", () => {
    render(<FundPositionsView page={page()} />);
    const table = screen.getByRole("table", { name: "Index fund weight changes between the two dates" });
    const wes = within(table).getByRole("row", { name: /WES/ });
    expect(within(wes).getAllByText("n/a").length).toBeGreaterThanOrEqual(2);
    expect(within(wes).getByText("New")).toBeInTheDocument();
  });

  it("is read-only without a change handler, and reports a single snapshot date in its place", () => {
    const { rerender } = render(<FundPositionsView page={page()} />);
    expect(screen.getByRole("slider", { name: "Earlier snapshot" })).toHaveAttribute("tabindex", "-1");
    rerender(<FundPositionsView page={page({ snapshotDates: ["2026-10-31"] })} />);
    expect(screen.queryByRole("group", { name: "Snapshot dates of the index fund window" })).toBeNull();
    expect(screen.getByText(/one file date so far/)).toBeInTheDocument();
  });

  it("makes a stock's code a toggle when a select handler is given", () => {
    const onSelect = jest.fn();
    render(<FundPositionsView page={page()} selectedCode="BHP" onSelect={onSelect} />);
    const bhp = screen.getByRole("button", { name: /BHP/ });
    expect(bhp).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(bhp);
    expect(onSelect).toHaveBeenCalledWith("BHP");
  });
});

describe("FundStockPanel", () => {
  const funds: FundSeriesRow[] = [
    {
      institutionSlug: "vanguard",
      institutionName: "Vanguard",
      fundName: "Australian Shares Index",
      sourceKind: "etf",
      points: [
        { asAt: "2026-09-30", weightPct: 5, valueAud: 500 },
        { asAt: "2026-10-31", weightPct: 5.2, valueAud: 520 },
      ],
    },
  ];

  it("names the stock, and each fund with its institution and file date range", () => {
    render(<FundStockPanel code="BHP" name="BHP Group" funds={funds} />);
    expect(screen.getByRole("heading", { name: /BHP BHP Group/ })).toBeInTheDocument();
    expect(screen.getByText("Vanguard")).toBeInTheDocument();
    expect(screen.getByText("as at 2026-09-30 to 2026-10-31")).toBeInTheDocument();
  });

  it("says so when no tracked fund holds the stock", () => {
    render(<FundStockPanel code="XYZ" name="" funds={[]} />);
    expect(screen.getByText(/No index fund file or super option disclosure tracked holds XYZ/)).toBeInTheDocument();
  });
});

describe("FundPositionsView reads of no window", () => {
  it("prints the outage in place of the window when the read did not answer", () => {
    render(<FundPositionsView page={page({ ok: false, error: "", rows: [], snapshotDates: [], from: "", to: "" })} />);
    expect(screen.getByText(FUND_POSITIONS_OUTAGE)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Snapshot dates of the index fund window" })).toBeNull();
    expect(screen.queryByText(/one file date so far/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("prints a refusal's own reason in place of the window", () => {
    render(
      <FundPositionsView page={page({ ok: false, error: "until is before since", rows: [], snapshotDates: [] })} />,
    );
    expect(screen.getByText("until is before since")).toBeInTheDocument();
    expect(screen.queryByText(FUND_POSITIONS_OUTAGE)).toBeNull();
  });

  it("says there is no file yet, not one file date, when no snapshot date exists", () => {
    render(<FundPositionsView page={page({ snapshotDates: [], rows: [], from: "", to: "" })} />);
    expect(screen.getByText("No index fund file is tracked yet, so there is no window to draw.")).toBeInTheDocument();
    expect(screen.queryByText(/one file date so far/)).toBeNull();
  });

  it("keeps one status row mounted, and puts a line in it when there is one", () => {
    const { rerender } = render(<FundPositionsView page={page()} />);
    const bare = screen.getByRole("status");
    expect(bare).toBeEmptyDOMElement();
    rerender(<FundPositionsView page={page()} status="Loading…" />);
    expect(screen.getByRole("status")).toBe(bare);
    expect(bare).toHaveTextContent("Loading…");
  });
});

describe("fund changes beneath the precision", () => {
  it("leaves out a stock whose weight moved under 0.005 points, and takes no sign on a rise that prints as $0", () => {
    const tiny = row({ code: "TNY", weightFrom: 2, weightTo: 2.001, delta: 0.001 });
    const lists = fundPositionLists([...ROWS, tiny]);
    expect([...lists.rises, ...lists.falls].map((r) => r.code)).not.toContain("TNY");
    expect(formatValueChange(0.4)).not.toMatch(/^\+/);
  });
});
