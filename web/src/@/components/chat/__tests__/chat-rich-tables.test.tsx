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

/** A most-shorted answer for one stock, with two readings a week apart. */
function twoReadings(first: number, last: number): string {
  return JSON.stringify({
    timeSeries: [
      {
        productCode: "AAA",
        name: "Aaa Ltd",
        latestShortPosition: last,
        points: [
          { timestamp: "2026-10-01T00:00:00Z", shortPosition: first },
          { timestamp: "2026-10-08T00:00:00Z", shortPosition: last },
        ],
      },
    ],
  });
}

describe("TopShortsTable change colour", () => {
  it("colours a move too small to print as neutral, the same as no change", async () => {
    render(<TopShortsTable view={parseTopShorts(twoReadings(10, 10.004))!} />);

    const change = screen.getByText("0.00 pp");
    expect(change.className).toContain("text-muted-foreground");
    expect(change.className).not.toContain("text-red-700");
    expect(change.className).not.toContain("text-emerald-700");
    await screen.findByRole("group", { name: /AAA short interest/ });
  });

  it("colours a small fall neutral too, since it prints as 0.00 pp", async () => {
    render(<TopShortsTable view={parseTopShorts(twoReadings(10.004, 10))!} />);

    const change = screen.getByText("0.00 pp");
    expect(change.className).toContain("text-muted-foreground");
    await screen.findByRole("group", { name: /AAA short interest/ });
  });

  it("colours a move that prints as a rise red, with its sign", async () => {
    render(<TopShortsTable view={parseTopShorts(twoReadings(10, 10.006))!} />);

    const change = screen.getByText("+0.01 pp");
    expect(change.className).toContain("text-red-700");
    await screen.findByRole("group", { name: /AAA short interest/ });
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
    expect(within(row).getByText(/11 Sep 2026 · Buy/)).toBeInTheDocument();
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

  it("keeps the table when the budget left none to draw, and counts them in its footer", () => {
    // The chat's prompt tells the model these answers are shown as a table, so one is drawn.
    const view = parseDirectorTrades(JSON.stringify({ totalCount: 3, omittedTrades: 3 }))!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    const table = screen.getByRole("table", { name: "Director trades in BHP" });
    expect(within(table).getByRole("columnheader", { name: "Director" })).toBeInTheDocument();
    expect(within(table).queryAllByRole("rowheader")).toHaveLength(0);
    expect(screen.getByText("3 more not shown")).toBeInTheDocument();
  });

  it("does not draw an empty table for an answer with no trades and no count", () => {
    render(<DirectorTradesTable view={parseDirectorTrades("{\"trades\":[]}")!} code="BHP" />);
    expect(screen.getByText("No director trades reported for BHP.")).toBeInTheDocument();
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

/** The table's width, as a browser lays it out: the sidebar's, a phone's or the /chat page's. */
function atWidth(px: number) {
  return jest.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(px);
}

describe("rich tables at each width", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps the most-shorted figures at a phone's width and draws the trend from the sidebar up", async () => {
    atWidth(223);
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    const { unmount } = render(<TopShortsTable view={view} />);

    expect(screen.getByRole("columnheader", { name: "Stock" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Short" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Change" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Trend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /short interest/ })).not.toBeInTheDocument();
    unmount();
  });

  it("draws the most-shorted trend at the sidebar's width, at 64px", async () => {
    atWidth(331);
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);

    expect(screen.getByRole("columnheader", { name: "Trend" })).toBeInTheDocument();
    const spark = await screen.findByRole("group", { name: /DRO short interest/ });
    expect(spark.querySelector("svg")).toHaveAttribute("width", "64");
  });

  it("draws the most-shorted trend at the /chat page's width, at 96px", async () => {
    atWidth(620);
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);

    const spark = await screen.findByRole("group", { name: /DRO short interest/ });
    expect(spark.querySelector("svg")).toHaveAttribute("width", "96");
  });

  it("marks the subject of a peer comparison by its row, and names it to a screen reader at a phone's width", () => {
    atWidth(223);
    render(<PeersTable view={parsePeers(fixture("get_peer_comparison-bhp.json"))!} />);

    const subject = rowFor("BHP");
    expect(subject.className).toContain("bg-primary/10");
    expect(within(subject).getByText("This stock", { selector: ".sr-only" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "P/E" })).not.toBeInTheDocument();
  });

  it("shows the subject's badge, and the P/E, at the sidebar's width", () => {
    atWidth(331);
    render(<PeersTable view={parsePeers(fixture("get_peer_comparison-bhp.json"))!} />);

    expect(screen.getByText("This stock")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "P/E" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Yield" })).not.toBeInTheDocument();
  });

  it("draws every peer column at the /chat page's width", () => {
    atWidth(620);
    render(<PeersTable view={parsePeers(fixture("get_peer_comparison-bhp.json"))!} />);

    expect(screen.getByRole("columnheader", { name: "Yield" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "1-month price" })).toBeInTheDocument();
  });

  it("abbreviates a director's value below the /chat page's width, and drops the Notice column", () => {
    atWidth(223);
    render(<DirectorTradesTable view={parseDirectorTrades(fixture("get_director_trades-bhp.json"))!} code="BHP" />);

    expect(screen.getByRole("columnheader", { name: "Value" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Notice" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Shares" })).not.toBeInTheDocument();
    expect(screen.getByText("$161.8K")).toBeInTheDocument();
  });

  it("makes the director's name the notice link below the full width, with the same safe href", () => {
    atWidth(223);
    render(<DirectorTradesTable view={parseDirectorTrades(fixture("get_director_trades-bhp.json"))!} code="BHP" />);

    const link = screen.getByRole("link", { name: /Mark Vassella.*opens in a new tab/ });
    expect(link).toHaveAttribute("href", expect.stringMatching(/^https:\/\/www\.asx\.com\.au\//));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows a trade's share count where the feed gave no value, below the standard width", () => {
    atWidth(223);
    const view = parseDirectorTrades(
      JSON.stringify({
        trades: [{ directorName: "Ann Lee", tradeType: "buy", tradeDate: "2026-10-01", sharesTraded: 29756 }],
      }),
    )!;
    render(<DirectorTradesTable view={view} code="BHP" />);

    expect(screen.getByText("29,756 shares")).toBeInTheDocument();
    expect(screen.queryByText("Not available")).not.toBeInTheDocument();
  });

  it("keeps the share count in its own column from the standard width, with the value beside it", () => {
    atWidth(331);
    render(<DirectorTradesTable view={parseDirectorTrades(fixture("get_director_trades-bhp.json"))!} code="BHP" />);

    expect(screen.getByRole("columnheader", { name: "Shares" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Notice" })).not.toBeInTheDocument();
    expect(screen.queryByText(/ shares$/)).not.toBeInTheDocument();
  });

  it("draws the price and every figure at the /chat page's width", () => {
    atWidth(620);
    render(<DirectorTradesTable view={parseDirectorTrades(fixture("get_director_trades-bhp.json"))!} code="BHP" />);

    expect(screen.getByRole("columnheader", { name: "Price" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Shares" })).toBeInTheDocument();
  });
});

describe("the change colours", () => {
  // The tokens behind the table's background and the site's muted text, in light and dark.
  // The colours are the Tailwind palette values the classes resolve to.
  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const sat = s / 100;
    const light = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const f = (n: number) =>
      light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number];
  }
  function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function luminance([r, g, b]: [number, number, number]): number {
    const [lr, lg, lb] = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
  }
  function contrast(a: [number, number, number], b: [number, number, number]): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (light + 0.05) / (dark + 0.05);
  }

  const lightBackground = hslToRgb(40, 25, 97); // --background, and the table's bg-background/60 over it
  const lightMuted = hslToRgb(40, 15, 94); // --muted
  const darkBackground = hslToRgb(0, 0, 5);
  const darkMuted = hslToRgb(0, 0, 12);

  it.each([
    ["text-red-700", "#b91c1c", lightBackground, lightMuted],
    ["text-emerald-700", "#047857", lightBackground, lightMuted],
  ])("keeps %s at 4.5:1 or better on the light table", (_name, hex, background, muted) => {
    const rgb = hexToRgb(hex);
    expect(contrast(rgb, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb, muted)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["dark:text-red-400", "#f87171"],
    ["dark:text-emerald-400", "#34d399"],
  ])("keeps %s at 4.5:1 or better on the dark table", (_name, hex) => {
    const rgb = hexToRgb(hex);
    expect(contrast(rgb, darkBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb, darkMuted)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("rich tables: what a row shows and how it fills the width", () => {
  it("says which rows have a change and a trend, when the budget cleared the rest", () => {
    const view = parseTopShorts(fixture("get_top_shorts-50.json"))!;
    render(<TopShortsTable view={view} />);
    expect(screen.getByText("Change and trend are shown for the top 7 only.")).toBeInTheDocument();
  });

  it("names only the change below the standard width, where the trend is not drawn", () => {
    atWidth(223);
    render(<TopShortsTable view={parseTopShorts(fixture("get_top_shorts-50.json"))!} />);

    expect(screen.queryByRole("columnheader", { name: "Trend" })).not.toBeInTheDocument();
    expect(screen.getByText("Change is shown for the top 7 only.")).toBeInTheDocument();
  });

  it.each([270, 320, 720])("keeps each change and short figure on one line at %ipx", (px) => {
    atWidth(px);
    render(<TopShortsTable view={parseTopShorts(fixture("get_top_shorts-10.json"))!} />);

    // A wrapped figure, or its date, turns the change column into four lines of text.
    const change = screen.getAllByText(/ pp$/)[0]!;
    expect(change.closest(".whitespace-nowrap")).not.toBeNull();
    expect(screen.getAllByText(/^since /)[0]!.className).toContain("block");
    expect(screen.getByText("15.93%").className).toContain("whitespace-nowrap");
  });

  it("lets a company name take the width the figures leave below the full width", () => {
    atWidth(223);
    render(<TopShortsTable view={parseTopShorts(fixture("get_top_shorts-10.json"))!} />);

    const name = screen.getAllByTitle(/^Droneshield$/)[0]!;
    expect(name.className).not.toContain("max-w-");
    expect(name.className).toContain("truncate");
  });

  it("says nothing of the sort when every row has its readings", () => {
    const view = parseTopShorts(fixture("get_top_shorts-10.json"))!;
    render(<TopShortsTable view={view} />);
    expect(screen.queryByText(/Change and trend are/)).not.toBeInTheDocument();
  });

  it("lets a director's name take the width the figures leave", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp.json"))!;
    render(<DirectorTradesTable view={view} code="BHP" />);
    const header = screen.getAllByRole("rowheader")[0]!;
    expect(header.className).toContain("w-full");
    expect(header.className).toContain("max-w-0");
  });

  it("lets a trade's date and type wrap beneath the name, rather than cut the type short", () => {
    const view = parseDirectorTrades(fixture("get_director_trades-bhp.json"))!;
    render(<DirectorTradesTable view={view} code="BHP" />);
    const detail = screen.getAllByRole("rowheader")[0]!.querySelector(".text-\\[11px\\]")!;
    expect(detail.className).not.toContain("truncate");
    expect(detail.className).toContain("break-words");
    expect(detail.textContent).toMatch(/ · /);
  });

  it("marks the subject of a peer comparison with a bar on its first cell, not only a tint", () => {
    const view = parsePeers(fixture("get_peer_comparison-bhp.json"))!;
    render(<PeersTable view={view} />);
    const subject = screen.getByRole("rowheader", { name: /BHP/ }).closest("tr")!;
    expect(subject.className).toContain("[&>th:first-child]:shadow-");
    expect(subject.className).toContain("font-semibold");
  });
});
