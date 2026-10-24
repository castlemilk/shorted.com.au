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

describe("TopShortsTable (recorded)", () => {
  it("is a captioned table with one row per stock, each linked to its page", async () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);

    const table = screen.getByRole("table", { name: "Most shorted ASX stocks" });
    expect(within(table).getAllByRole("rowheader")).toHaveLength(10);
    expect(within(table).getByRole("link", { name: "DRO" })).toHaveAttribute(
      "href",
      "/shorts/DRO",
    );
    // The sparklines load on demand: wait for them so the load finishes inside the test.
    await screen.findAllByRole("group", { name: /short interest, last three months/ });
  });

  it("shows the short position to two decimals and the change across the sparkline", async () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);

    const row = screen.getByRole("rowheader", { name: "DRO" }).closest("tr")!;
    expect(within(row).getByRole("cell", { name: "15.93%" })).toBeInTheDocument();

    // Latest minus the first reading: 15.9283 - 13.1075 is +2.82 points.
    const change = within(row).getByText(/pp$/);
    expect(change.textContent).toMatch(/^\+2\.82 pp$/);
    expect(change.className).toContain("text-red-500");

    // The sparkline loads on demand; it is a group with a name, not a bare picture.
    expect(
      await within(row).findByRole("group", {
        name: /DRO short interest, last three months/,
      }),
    ).toBeInTheDocument();
  });

  it("marks a row with no sparkline points with an em dash, not a number", async () => {
    const view = parseTopShorts(fixture("get_top_shorts-50.json"))!;
    render(<TopShortsTable view={view} />);

    const row = screen.getByRole("rowheader", { name: "FLT" }).closest("tr")!;
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(within(row).getAllByText("Not available").length).toBeGreaterThanOrEqual(2);
    await screen.findAllByRole("group", { name: /short interest, last three months/ });
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
  it("captions the peers with the subject and its industry, and lists five rows", () => {
    const view = parsePeers(fixture("get_peer_comparison-bhp.json"))!;
    render(<PeersTable view={view} />);

    const table = screen.getByRole("table", { name: "Peers of BHP in Materials" });
    expect(within(table).getAllByRole("rowheader")).toHaveLength(5);
    expect(within(table).getByRole("link", { name: "RIO" })).toHaveAttribute("href", "/shorts/RIO");
  });

  it("formats the short position, the market cap and the one-month change", () => {
    const view = parsePeers(fixture("get_peer_comparison-bhp.json"))!;
    render(<PeersTable view={view} />);

    const row = screen.getByRole("rowheader", { name: "RIO" }).closest("tr")!;
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
    const row = screen.getByRole("rowheader", { name: "NEM" }).closest("tr")!;
    // The P/E cell is a dash of its own: the row also has dashes for the fields it lacks.
    const pe = within(row).getAllByRole("cell")[4]!;
    expect(within(pe).getByText("Not available")).toBeInTheDocument();
    expect(within(pe).queryByText(/\d/)).not.toBeInTheDocument();
  });
});

describe("DirectorTradesTable (recorded)", () => {
  it("lists the trades with their type, shares and value, and links each notice", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp.json"))!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    const table = screen.getByRole("table", { name: "Director trades in BHP" });
    const row = within(table).getByRole("cell", { name: "Mark Vassella" }).closest("tr")!;
    expect(within(row).getByText("Buy")).toBeInTheDocument();
    expect(within(row).getByText("2,675")).toBeInTheDocument();
    expect(within(row).getByText("$60.50")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /Notice/ })).toHaveAttribute(
      "href",
      expect.stringMatching(/^https:\/\/www\.asx\.com\.au\//),
    );
  });

  it("leaves a trade with no shares or value as dashes", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp.json"))!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    const table = screen.getByRole("table", { name: "Director trades in BHP" });
    // The fixture has several "Unknown Director" trades; the first one has no share or value fields.
    const row = within(table).getAllByRole("cell", { name: "Unknown Director" })[0]!.closest("tr")!;
    expect(within(row).getAllByText("Not available").length).toBeGreaterThanOrEqual(3);
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
