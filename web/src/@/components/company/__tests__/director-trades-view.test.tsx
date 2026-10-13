import fs from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import type { DirectorTrade } from "~/gen/shorts/v1alpha1/stock_pb";
import { DIRECTOR_TRADES_LIMIT, DirectorTradesView } from "../director-trades-view";

// A message as the API sends it: sharesTraded is an int64, so a bigint.
const trade = (over: Record<string, unknown> = {}): DirectorTrade =>
  ({
    id: "t1",
    stockCode: "BHP",
    tradeDate: "2026-09-30",
    directorName: "Jane Citizen",
    tradeType: "buy",
    sharesTraded: BigInt(12000),
    pricePerShare: 43.21,
    totalValue: 518520,
    announcementUrl: "https://announcements.example/t1.pdf",
    ...over,
  }) as unknown as DirectorTrade;

describe("DirectorTradesView", () => {
  it("lists a trade as one row: date, director, type, shares, price, value and the announcement", () => {
    render(<DirectorTradesView trades={[trade()]} totalCount={1} />);
    expect(screen.getByRole("heading", { level: 3, name: "Director trades" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["Date", "Director", "Type", "Shares", "Price", "Value", ""]);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    const cells = within(rows[1]!).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "2026-09-30",
      "Jane Citizen",
      "buy",
      "12,000",
      "$43.210",
      "$518,520",
      "",
    ]);
    const link = within(cells[6]!).getByRole("link");
    expect(link).toHaveAttribute("href", "https://announcements.example/t1.pdf");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("counts the trades, with the plural only when there is not exactly one", () => {
    const { rerender } = render(<DirectorTradesView trades={[trade()]} totalCount={1} />);
    expect(screen.getByText("1 trade recorded")).toBeInTheDocument();
    rerender(
      <DirectorTradesView
        trades={[trade(), trade({ id: "t2", directorName: "John Citizen" })]}
        totalCount={2}
      />,
    );
    expect(screen.getByText("2 trades recorded")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("prints the trade type without its underscores, and styles the types it knows", () => {
    render(
      <DirectorTradesView
        trades={[
          trade({ id: "a", tradeType: "exercise_options" }),
          trade({ id: "b", tradeType: "sell" }),
          trade({ id: "c", tradeType: "transfer" }),
        ]}
        totalCount={3}
      />,
    );
    expect(screen.getByText("exercise options")).toHaveClass("bg-stone-500/15");
    expect(screen.getByText("sell")).toHaveClass("bg-red-100");
    // A type with no style still prints.
    expect(screen.getByText("transfer")).toBeInTheDocument();
  });

  it("prints a dash for a figure the trade does not carry, and no link without an announcement", () => {
    render(
      <DirectorTradesView
        trades={[
          trade({
            sharesTraded: BigInt(0),
            pricePerShare: 0,
            totalValue: 0,
            announcementUrl: "",
          }),
        ]}
        totalCount={1}
      />,
    );
    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    expect(cells.slice(3, 6).map((cell) => cell.textContent)).toEqual(["-", "-", "-"]);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("reads the same whatever the host's locale is: every number is formatted for en-AU", () => {
    const toLocaleString = jest.spyOn(Number.prototype, "toLocaleString");
    try {
      render(<DirectorTradesView trades={[trade()]} totalCount={1} />);
      expect(toLocaleString).toHaveBeenCalled();
      for (const call of toLocaleString.mock.calls) expect(call[0]).toBe("en-AU");
    } finally {
      toLocaleString.mockRestore();
    }
  });

  it("says there are none, under the card's title, and draws no table", () => {
    render(<DirectorTradesView trades={[]} totalCount={0} />);
    expect(screen.getByRole("heading", { level: 3, name: "Director trades" })).toBeInTheDocument();
    expect(screen.getByText("No director trades found")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/recorded/)).toBeNull();
  });

  it("decides the empty card by the rows it is given, not by the count", () => {
    render(<DirectorTradesView trades={[]} totalCount={5} />);
    expect(screen.getByText("No director trades found")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists the same number of trades the page asks for and the island's query defaults to", () => {
    expect(DIRECTOR_TRADES_LIMIT).toBe(20);
  });
});

// The Company page is a server component and renders this from its own read.
// It may not become a client module (a client module is hydrated, and its
// bigint props could not cross the boundary), and may not pull Connect-RPC or
// the generated clients into a server bundle: only the types come from the
// generated code (CLAUDE.md, "SSR Issues with @connectrpc/connect").
describe("director-trades-view.tsx is server-safe", () => {
  const source = fs.readFileSync(path.join(__dirname, "../director-trades-view.tsx"), "utf8");
  const imports = Array.from(
    source.matchAll(/^\s*import\b([^;]*?)\bfrom\s+["']([^"']+)["']/gm),
    (m) => ({ clause: m[1]!.trim(), specifier: m[2]! }),
  );

  it('has no "use client" directive', () => {
    expect(source).not.toMatch(/^\s*["']use client["']/m);
  });

  it("imports nothing from Connect, protobuf or the island it stands behind", () => {
    expect(imports.length).toBeGreaterThan(0);
    for (const { specifier } of imports) {
      expect(specifier).not.toMatch(/connectrpc|bufbuild|director-trades-table|actions\/client\//);
    }
  });

  it("takes only types from the generated code", () => {
    const generated = imports.filter(({ specifier }) => /~\/gen\//.test(specifier));
    expect(generated.length).toBeGreaterThan(0);
    for (const { clause } of generated) expect(clause).toMatch(/^type\b/);
  });
});
