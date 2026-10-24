import { readFileSync } from "fs";
import { join } from "path";
import { render, screen, within } from "@testing-library/react";
import { DirectorTradesTable, PeersTable, TopShortsTable } from "../chat-rich-tables";
import {
  parseDirectorTrades,
  parsePeers,
  parseTopShorts,
} from "../chat-tool-data";

/** The exact result strings the chat service returned, recorded on 2026-10-24. */
function fixture(name: string): string {
  return readFileSync(
    join(__dirname, "..", "__fixtures__", "tool-results", name),
    "utf8",
  );
}

/**
 * The row whose row header names the stock. A header holds an optional rank, then the
 * code, then the company name, so the code is matched at the start of its text.
 */
function rowFor(code: string): HTMLElement {
  const header = screen
    .getAllByRole("rowheader")
    .find((cell) => new RegExp(`^\\d*${code}`).test(cell.textContent ?? ""));
  if (!header) throw new Error(`no row header for ${code}`);
  return header.closest("tr")!;
}

describe("TopShortsTable (recorded)", () => {
  it("is a captioned table with one row per stock, each code linked to its page", async () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);

    const table = screen.getByRole("table", { name: "Most shorted ASX stocks" });
    expect(within(table).getAllByRole("rowheader")).toHaveLength(10);
    expect(within(table).getByRole("link", { name: "DRO" })).toHaveAttribute(
      "href",
      "/shorts/DRO",
    );
    // The sparklines load on demand: wait for them so the load finishes inside the test.
    await screen.findAllByRole("group", { name: /short interest/ });
  });

  it("numbers each row by its rank, with the company name beneath the code", async () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);

    const row = rowFor("DRO");
    expect(within(row).getByRole("rowheader")).toHaveTextContent(/^1DRO/);
    expect(within(row).getByRole("rowheader")).toHaveTextContent("Droneshield");
    await screen.findAllByRole("group", { name: /short interest/ });
  });

  it("shows the short position to two decimals and the change across the sparkline", async () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);

    const row = rowFor("DRO");
    expect(within(row).getByRole("cell", { name: "15.93%" })).toBeInTheDocument();

    // Latest minus the first reading: 15.9283 - 13.1075 is +2.82 points.
    const change = within(row).getByText(/pp$/);
    expect(change.textContent).toMatch(/^\+2\.82 pp$/);
    expect(change.className).toContain("text-red-700");
    expect(change.className).toContain("dark:text-red-400");

    // The day the change is counted from, so a short run of readings reads as what it is.
    expect(within(row).getByText(/^since \d+ \w+$/)).toBeInTheDocument();

    // The sparkline loads on demand; it is a group with a name, not a bare picture.
    expect(
      await within(row).findByRole("group", { name: /DRO short interest/ }),
    ).toBeInTheDocument();
  });

  it("labels the change column by what it measures, not by a period", () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);

    expect(screen.getByRole("columnheader", { name: "Change" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /3-month/ })).not.toBeInTheDocument();
  });

  it("marks a row with no sparkline points with an em dash, not a number", async () => {
    const view = parseTopShorts(fixture("get_top_shorts-50.json"))!;
    render(<TopShortsTable view={view} />);

    const row = rowFor("FLT");
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(within(row).getAllByText("Not available").length).toBeGreaterThanOrEqual(2);
    await screen.findAllByRole("group", { name: /short interest/ });
  });

  it("names the stocks the tool left out", () => {
    const view = parseTopShorts(
      JSON.stringify({
        timeSeries: [{ productCode: "DRO", name: "Droneshield", latestShortPosition: 15.9, points: [] }],
        omittedStocks: 40,
      }),
    )!;
    render(<TopShortsTable view={view} />);
    expect(screen.getByText("40 more not shown")).toBeInTheDocument();
  });

  it("says so, rather than drawing an empty table, when there are no rows", () => {
    render(<TopShortsTable view={{ rows: [], notShown: 0 }} />);
    expect(screen.getByText("No stocks to show.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("PeersTable (recorded)", () => {
  it("captions the peers with the subject and its industry, and lists the subject first", () => {
    const view = parsePeers(fixture("get_peer_comparison-bhp.json"))!;
    render(<PeersTable view={view} />);

    const table = screen.getByRole("table", { name: "Peers of BHP in Materials" });
    // The subject and its five peers: six rows.
    expect(within(table).getAllByRole("rowheader")).toHaveLength(6);
    const first = within(table).getAllByRole("rowheader")[0]!.closest("tr")!;
    expect(first).toHaveTextContent("BHP");
    expect(within(first).getByText("This stock")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "RIO" })).toHaveAttribute("href", "/shorts/RIO");
  });

  it("formats the short position, the market cap and the one-month change", () => {
    const view = parsePeers(fixture("get_peer_comparison-bhp.json"))!;
    render(<PeersTable view={view} />);

    const row = rowFor("RIO");
    expect(within(row).getByRole("cell", { name: "8.76%" })).toBeInTheDocument();
    expect(within(row).getByText(/285/)).toBeInTheDocument();
    expect(within(row).getByText("-9.62%")).toBeInTheDocument();
  });

  it("shows a dash for a P/E ratio that is not positive", () => {
    const view = parsePeers(
      JSON.stringify({
        subject: { stockCode: "XYZ" },
        peers: [{ stockCode: "NEM", peRatio: -3.2 }],
      }),
    )!;
    render(<PeersTable view={view} />);
    const row = rowFor("NEM");
    // The cells after the row header are short, market cap, P/E, yield and the one-month
    // change, so P/E is the third.
    const pe = within(row).getAllByRole("cell")[2]!;
    expect(within(pe).getByText("Not available")).toBeInTheDocument();
    expect(within(pe).queryByText(/\d/)).not.toBeInTheDocument();
  });
});

describe("DirectorTradesTable (recorded)", () => {
  it("lists the trades with their date, type, shares and value, and links each notice", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp.json"))!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    const table = screen.getByRole("table", { name: "Director trades in BHP" });
    const row = within(table).getByRole("rowheader", { name: /Mark Vassella/ }).closest("tr")!;
    expect(within(row).getByText(/11 Sept 2026 · Buy/)).toBeInTheDocument();
    expect(within(row).getByText("2,675")).toBeInTheDocument();
    expect(within(row).getByText("$60.50")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /Notice/ })).toHaveAttribute(
      "href",
      expect.stringMatching(/^https:\/\/www\.asx\.com\.au\//),
    );
  });

  it("leaves a trade with no shares, price or value as dashes", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp.json"))!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    const table = screen.getByRole("table", { name: "Director trades in BHP" });
    // The fixture has several "Unknown Director" trades; the first one has no share, price or value.
    const row = within(table).getAllByRole("rowheader", { name: /Unknown Director/ })[0]!.closest("tr")!;
    expect(within(row).getAllByText("Not available").length).toBeGreaterThanOrEqual(3);
  });

  it("draws the budget-trimmed fifty-row answer and names the eight trades it left out", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp-50.json"))!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    const table = screen.getByRole("table", { name: "Director trades in BHP" });
    expect(within(table).getAllByRole("rowheader")).toHaveLength(36);
    expect(screen.getByText("8 more not shown")).toBeInTheDocument();
  });

  it("says how many trades were reported when the budget left none to draw", () => {
    const view = parseDirectorTrades(JSON.stringify({ totalCount: 3, omittedTrades: 3 }))!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    expect(screen.getByText("3 director trades were reported but cannot be shown.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says there are no trades for the stock on the empty answer {}", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-glc-none.json"))!;
    render(<DirectorTradesTable view={view} code="GLC" />);

    expect(screen.getByText("No director trades reported for GLC.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("does not make an announcement link out of a non-http address", () => {
    const view = parseDirectorTrades(
      JSON.stringify({
        trades: [{ directorName: "A", tradeType: "buy", announcementUrl: "javascript:alert(1)" }],
      }),
    )!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    expect(screen.queryByRole("link", { name: /Notice/ })).not.toBeInTheDocument();
  });
});
