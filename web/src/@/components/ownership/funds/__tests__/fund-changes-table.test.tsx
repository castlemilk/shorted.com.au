/// <reference types="jest" />

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FundChangesTableView, type FundChangesTableProps } from "../fund-changes-table";
import type { FundComparison } from "../fund-model";

const MINUS = String.fromCharCode(0x2212);

const COMPARISON: FundComparison = {
  ok: true,
  from: "2026-09-30",
  to: "2026-10-31",
  sourceFrom: "https://example.com/a.csv",
  sourceTo: "https://example.com/b.csv",
  rows: [
    { code: "CBA", name: "Commonwealth Bank", industry: "Banks", weightFrom: 10.1, weightTo: 10.2, deltaPp: 0.1, valueFrom: null, valueTo: null, status: "continuing" },
    { code: "BHP", name: "BHP Group", industry: "Materials", weightFrom: 8.7, weightTo: 8.39, deltaPp: -0.31, valueFrom: null, valueTo: null, status: "continuing" },
    { code: "NEW", name: "New Co", industry: "Insurance", weightFrom: null, weightTo: 1.2, deltaPp: null, valueFrom: null, valueTo: null, status: "new" },
  ],
};

function props(overrides: Partial<FundChangesTableProps> = {}): FundChangesTableProps {
  return {
    funds: [{ key: "asx:A200", ticker: "A200", name: "A200 fund", snapshotCount: 2 }],
    defaults: { fund: "asx:A200", from: "2026-09-30", to: "2026-10-31" },
    defaultDates: ["2026-09-30", "2026-10-31"],
    initial: COMPARISON,
    loadPortfolio: jest.fn(async () => ({ ok: true, fund: null })),
    compare: jest.fn(async () => COMPARISON),
    ...overrides,
  };
}

function renderTable(search: string, overrides: Partial<FundChangesTableProps> = {}, navigate = jest.fn()) {
  render(
    <FundChangesTableView
      {...props(overrides)}
      params={new URLSearchParams(search)}
      pathname="/ownership/changes"
      navigate={navigate}
    />,
  );
  return navigate;
}

describe("the fund change table (spec 14.3, Changes)", () => {
  it("prints each weight, a change with a true minus, and the status in words", () => {
    renderTable("");
    const table = screen.getByRole("table");
    const bhp = within(table).getByRole("link", { name: "BHP" }).closest("tr");
    expect(within(bhp!).getByText(`${MINUS}0.31 pp`)).toBeInTheDocument();
    expect(within(bhp!).getByText("Continuing")).toBeInTheDocument();
    const nw = within(table).getByRole("link", { name: "NEW" }).closest("tr");
    expect(within(nw!).getByText("Newly reported")).toBeInTheDocument();
    expect(within(nw!).getAllByText("n/a")).toHaveLength(2);
  });

  it("links each company to its holding's selection, for the inspector", () => {
    renderTable("");
    expect(screen.getByRole("link", { name: "CBA" })).toHaveAttribute(
      "href",
      "/ownership/changes?sel=holding%3Aasx%3AA200%2FCBA",
    );
  });

  it("outlines the row of the held holding, and no other", () => {
    renderTable("sel=holding%3Aasx%3AA200%2FBHP");
    const table = screen.getByRole("table");
    const bhp = within(table).getByRole("link", { name: "BHP" }).closest("tr");
    expect(bhp).toHaveAttribute("aria-current", "true");
    expect(bhp).toHaveClass("bg-muted/40");
    const cba = within(table).getByRole("link", { name: "CBA" }).closest("tr");
    expect(cba).not.toHaveAttribute("aria-current");
  });

  it("keeps a date the URL names as an option, so the select shows what is compared", async () => {
    renderTable("from=2026-08-31&to=2026-10-31");
    // The pair differs from the defaults, so the table reads it: wait for that read to land.
    await screen.findByRole("table");
    const earlier = screen.getByRole("combobox", { name: /^Earlier/ });
    expect(earlier).toHaveValue("2026-08-31");
    expect(within(earlier).getByRole("option", { name: "2026-08-31" })).toBeInTheDocument();
  });

  it("filters the rows by the Show choice it makes, through the URL (spec 14.9: one toolbar row)", () => {
    const navigate = renderTable("");
    fireEvent.change(screen.getByRole("combobox", { name: /^Show/ }), { target: { value: "decreases" } });
    expect(navigate).toHaveBeenCalledWith("/ownership/changes?filter=decreases");
  });

  it("shows only the rows of the filter the URL names", () => {
    renderTable("filter=coverage");
    expect(screen.getByRole("link", { name: "NEW" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "CBA" })).not.toBeInTheDocument();
  });

  it("says the figures are exact file dates and that weights can move with prices, in one footnote", () => {
    renderTable("");
    expect(
      screen.getByText("Exact file dates shown · Comparable holdings only · Weight changes can reflect price moves."),
    ).toBeInTheDocument();
  });

  it("offers a CSV export only while there are rows to export", () => {
    renderTable("filter=coverage");
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  });

  it("says a fund with fewer than two files has nothing to compare, rather than loading forever", () => {
    renderTable("", { defaults: { fund: "asx:A200", from: "", to: "" }, defaultDates: ["2026-10-31"], initial: { ...COMPARISON, ok: false, rows: [] } });
    expect(screen.getByText("Two file dates of this fund are needed to compare them.")).toBeInTheDocument();
  });

  it("says an earlier snapshot after the later one is not a comparison, and reads nothing for it", () => {
    const compare = jest.fn(async () => COMPARISON);
    renderTable("from=2026-10-31&to=2026-09-30", { compare });
    expect(screen.getByText("The earlier snapshot must be before the later one.")).toBeInTheDocument();
    expect(compare).not.toHaveBeenCalled();
  });

  it("says a comparison that could not be read is an outage, not an empty file", () => {
    renderTable("", { initial: { ...COMPARISON, ok: false, rows: [] } });
    expect(screen.getByText(/this is our end/)).toBeInTheDocument();
  });

  it("reads a different fund's two files on demand, not the defaults", async () => {
    const compare = jest.fn(async () => COMPARISON);
    renderTable("fund=asx:IOZ&from=2026-08-31&to=2026-09-30", {
      funds: [
        { key: "asx:A200", ticker: "A200", name: "A200 fund", snapshotCount: 2 },
        { key: "asx:IOZ", ticker: "IOZ", name: "IOZ fund", snapshotCount: 2 },
      ],
      compare,
    });
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Loading");
    await waitFor(() => expect(compare).toHaveBeenCalledWith({ fundKey: "asx:IOZ", from: "2026-08-31", to: "2026-09-30" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});

describe("the change table's toolbar and caption (spec 14.3, B4)", () => {
  const FUNDS = [
    { key: "asx:IOZ", ticker: "IOZ", name: "iShares", snapshotCount: 3 },
    { key: "asx:A200", ticker: "A200", name: "Betashares", snapshotCount: 2 },
    { key: "asx:VAS", ticker: "VAS", name: "Vanguard", snapshotCount: 1 },
  ];

  it("lists the funds in the order given, each label with the one-file suffix where it applies", () => {
    renderTable("", { funds: FUNDS, defaults: { fund: "asx:IOZ", from: "", to: "" }, defaultDates: [] });
    const select = screen.getByRole("combobox", { name: /^Fund/ });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "IOZ · iShares",
      "A200 · Betashares",
      "VAS · Vanguard (one file)",
    ]);
  });

  it("keeps the four selects and the export inside the one toolbar row, and the note outside it (spec 14.9)", () => {
    renderTable("");
    const rows = document.querySelectorAll("[data-toolbar]");
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    for (const control of [
      screen.getByRole("combobox", { name: /^Fund/ }),
      screen.getByRole("combobox", { name: /^Earlier/ }),
      screen.getByRole("combobox", { name: /^Later/ }),
      screen.getByRole("combobox", { name: /^Show/ }),
      screen.getByRole("button", { name: "Export CSV" }),
    ]) {
      expect(row).toContainElement(control);
    }
    // The note is the footnote: a paragraph of its own, not a row control that could wrap the row.
    expect(row).not.toContainElement(screen.getByText(/^Exact file dates shown/));
  });

  it("names the comparison in the caption, with the count of holdings changed", () => {
    renderTable("");
    // The fixture's rows: CBA and BHP move, NEW is newly reported.
    expect(
      screen.getByText("A200, 2026-09-30 against 2026-10-31: 3 holdings changed. Reported snapshot change, not a trade record."),
    ).toBeInTheDocument();
  });

  it("names the dates the comparison was read for, never the selects' pending values", async () => {
    const compare = jest.fn(async () => COMPARISON);
    renderTable("from=2026-08-31&to=2026-10-31", { compare });
    await screen.findByRole("table");
    expect(screen.getByText(/^A200, 2026-09-30 against 2026-10-31:/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-08-31 against/)).not.toBeInTheDocument();
  });

  it("is the bare note when the comparison could not be read", () => {
    renderTable("", { initial: { ...COMPARISON, ok: false, rows: [] } });
    expect(screen.getByText("Reported snapshot change, not a trade record.")).toBeInTheDocument();
  });
});

describe("the change table's selection and dates (spec 14.3, Changes)", () => {
  it("clears the held selection when the earlier snapshot changes, so the rail never shows the old range", () => {
    const navigate = renderTable("sel=holding%3Aasx%3AA200%2FCBA&from=2026-09-30&to=2026-10-31");
    fireEvent.change(screen.getByRole("combobox", { name: /^Earlier/ }), { target: { value: "2026-09-30" } });
    const href = navigate.mock.calls[0]?.[0] as string;
    expect(href).toContain("from=2026-09-30");
    expect(href).not.toContain("sel=");
  });

  it("names its column headers by the two file dates", () => {
    renderTable("");
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "2026-09-30" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "2026-10-31" })).toBeInTheDocument();
  });

  it("has no expander on Changes: the inspector carries each row's figures (spec 14.9)", () => {
    renderTable("");
    expect(screen.queryAllByRole("button", { name: /Details|details/ })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /Show .* details/ })).toHaveLength(0);
  });
});
