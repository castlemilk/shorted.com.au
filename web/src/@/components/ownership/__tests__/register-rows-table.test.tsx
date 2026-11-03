import { render, screen, within } from "@testing-library/react";

import { RegisterRowsTable, registerSortHref, type RegisterStockRow } from "../register-rows-table";
import { defaultRegistersQuery, type RegistersQuery } from "~/@/lib/ownership/query";

const BHP: RegisterStockRow = {
  code: "BHP",
  companyName: "BHP Group",
  industry: "Materials",
  interests: "7",
  disclosed: "41.20%",
  disclosedPct: 41.2,
  byKind: [
    { kind: "super_fund", pct: 30.1, holders: 3 },
    { kind: "bank_broker", pct: 11.1, holders: 4 },
  ],
  institutions: "30.10%",
  banks: "11.10%",
  hedgeActive: "0.00%",
  index: "5.20%",
  indexAsAt: "as at 2026-09-30 to 2026-10-01",
  superOptions: "4",
  superValue: "$1.2B",
  short: "3.42%",
  shortAsOf: "2026-10-01",
  latestNotice: "2026-10-16",
};

const CBA: RegisterStockRow = {
  code: "CBA",
  companyName: "Commonwealth Bank",
  industry: "Financials",
  interests: "2",
  disclosed: "9.50%",
  disclosedPct: 9.5,
  byKind: [{ kind: "index_manager", pct: 9.5, holders: 2 }],
  institutions: "9.50%",
  banks: "n/a",
  hedgeActive: "n/a",
  index: "n/a",
  superOptions: "0",
  superValue: "n/a",
  short: "n/a",
  latestNotice: "",
};

const BASE = "/ownership/stocks";

function table(query: RegistersQuery = defaultRegistersQuery(), rows = [BHP, CBA]) {
  return render(
    <RegisterRowsTable
      rows={rows}
      query={query}
      basePath={BASE}
      caption="ASX substantial holder registers by stock"
    />,
  );
}

function head(name: string): HTMLElement {
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return screen.getByRole("columnheader", { name: new RegExp(`^${literal}`) });
}

/** The cells of a stock's row, in column order: Stock, Disclosed, Interests, Institutions, Banks, Hedge + active, Index, Super options, Super value, Short, Latest notice. */
function cellsOf(code: string): HTMLElement[] {
  const row = screen.getByRole("link", { name: code }).closest("tr");
  if (!row) throw new Error(`no row for ${code}`);
  return Array.from(row.children) as HTMLElement[];
}

/** The classes that decide whether an element shows at a width: its display and the grammar that shows it. */
function showClasses(element: Element): string[] {
  return Array.from(element.classList).filter((name) => /hidden|table-cell|block|container/.test(name));
}

describe("RegisterRowsTable", () => {
  it("marks the active sort head and reverses it on that head's link", () => {
    table({ ...defaultRegistersQuery(), sort: "disclosed", ascending: false });
    expect(head("Disclosed")).toHaveAttribute("aria-sort", "descending");
    expect(within(head("Disclosed")).getByRole("link")).toHaveAttribute("href", `${BASE}?dir=asc`);
    expect(head("Short")).toHaveAttribute("aria-sort", "none");
  });

  it("sorts a new head the way its measure reads: the code A to Z, the figures largest first", () => {
    table({ ...defaultRegistersQuery(), sort: "disclosed", ascending: false });
    expect(within(head("Stock")).getByRole("link")).toHaveAttribute("href", `${BASE}?sort=code&dir=asc`);
    expect(within(head("Short")).getByRole("link")).toHaveAttribute("href", `${BASE}?sort=short`);
  });

  it("keeps the filters a sort head carries, and resets the page", () => {
    const query = { ...defaultRegistersQuery(), industry: "Materials", kind: "super_fund" as const, offset: 50 };
    expect(registerSortHref(BASE, query, "short")).toBe(
      `${BASE}?sort=short&industry=Materials&kind=super_fund`,
    );
  });

  it("draws the code linked to its register page, with the company under it from the seven-column grammar and in the full-width row below it", () => {
    table();
    expect(screen.getByRole("link", { name: "BHP" })).toHaveAttribute("href", "/ownership/stocks/BHP");
    // The company is printed twice, and each copy shows at one width only: under the code in the Stock cell from the
    // seven-column grammar, and in the stock's full-width row below it.
    const [inCell, inRow] = screen.getAllByText("BHP Group");
    expect(cellsOf("BHP")[0]).toContainElement(inCell!);
    expect(inCell).toHaveClass("hidden", "[@container(min-width:980px)]:block", "[@container(min-width:980px)]:max-w-[14rem]", "[@container(min-width:980px)]:truncate");
    expect(inRow).toHaveClass("[@container(min-width:980px)]:hidden", "[overflow-wrap:anywhere]");
    expect(inRow!.closest("tr")).toHaveClass("[@container(min-width:1320px)]:hidden");
  });

  it("draws the disclosed bar on one scale for the table, from md at w-24 and from xl at w-32, beside its figure", () => {
    table();
    const bars = screen.getAllByRole("img", { name: /^Disclosed voting power/ });
    expect(bars).toHaveLength(2);
    // The largest disclosed sum fills the track; the others are drawn against it.
    expect(parseFloat(bars[0]!.style.width)).toBeCloseTo(100, 5);
    expect(parseFloat(bars[1]!.style.width)).toBeCloseTo((9.5 / 41.2) * 100, 5);
    expect(bars[0]!.closest("div.hidden")).toHaveClass("md:block", "w-24", "xl:w-32");
    expect(bars[0]!.getAttribute("aria-label")).toContain("not a share of the company");
    expect(cellsOf("BHP")[1]).toHaveTextContent("41.20%");
  });

  it("prints n/a for a figure the register does not hold, and never 0 in its place", () => {
    table();
    const cells = cellsOf("CBA");
    expect(cells[5]).toHaveTextContent(/^n\/a$/); // Hedge + active
    expect(cells[6]).toHaveTextContent(/^n\/a$/); // Index funds
    expect(cells[8]).toHaveTextContent(/^n\/a$/); // Super value
    expect(cells[9]).toHaveTextContent(/^n\/a$/); // Short
    expect(cells[10]).toHaveTextContent(/^n\/a$/); // Latest notice
    // A count the register does hold is printed as it is, even when it is zero.
    expect(cells[7]).toHaveTextContent(/^0$/); // Super options
  });

  it("prints interests and super options as counts", () => {
    table();
    expect(cellsOf("BHP")[2]).toHaveTextContent(/^7$/);
    expect(cellsOf("BHP")[7]).toHaveTextContent(/^4$/);
  });

  it("states the latest notice as the API sends it, in a time element", () => {
    table();
    const time = screen.getByText("2026-10-16");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", "2026-10-16");
  });

  it("holds the measures a phone does not draw in a details per row, with the industry", () => {
    const { container } = table();
    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(2);
    const bhp = details[0]!;
    expect(bhp.querySelector("summary")).toHaveTextContent("More figures for BHP");
    // A text-sized summary's hit area is the 24 px floor (DESIGN.md), by .hit-target.
    expect(bhp.querySelector("summary")).toHaveClass("hit-target");
    const dl = bhp.querySelector("dl")!;
    expect(dl).toHaveTextContent("Industry");
    expect(dl).toHaveTextContent("Materials");
    expect(dl).toHaveTextContent("Institutions");
    expect(dl).toHaveTextContent("30.10%");
    expect(dl).toHaveTextContent("$1.2B");
    // The short figure is in the figures row at every width; the details carry only its date.
    expect(dl).not.toHaveTextContent("3.42%");
    expect(dl).toHaveTextContent("as of 2026-10-01");
    // Two columns that can each shrink to their content, so a long label or figure cannot widen the row.
    expect(dl).toHaveClass("grid-cols-[minmax(0,auto)_minmax(0,1fr)]");
    // Capped at 24 rem from sm, so a label stays beside its figure on a desktop; a phone's list keeps the full width.
    expect(dl).toHaveClass("sm:max-w-sm");
    expect(dl).not.toHaveClass("max-w-sm");
  });

  it("hides the measures that are seven-column columns from the details at that grammar, and keeps the eleven-column ones in the details below the eleven-column grammar", () => {
    const { container } = table();
    const dl = container.querySelector("details")!.querySelector("dl")!;
    const label = (text: string) => Array.from(dl.querySelectorAll("dt")).find((dt) => dt.textContent === text)!;
    for (const text of ["Industry", "Institutions", "Index funds", "Super value", "Short"]) {
      expect(label(text)).toHaveClass("[@container(min-width:980px)]:hidden");
      expect(label(text).nextElementSibling).toHaveClass("[@container(min-width:980px)]:hidden");
    }
    for (const text of ["Interests", "Banks, brokers", "Hedge + active", "Super options"]) {
      expect(label(text)).not.toHaveClass("[@container(min-width:980px)]:hidden");
      expect(label(text).nextElementSibling).not.toHaveClass("[@container(min-width:980px)]:hidden");
    }
  });

  it("draws each stock's details in a full-width row under its own row, hidden from the eleven-column grammar, and keeps them out of the Stock cell", () => {
    const { container } = table();
    const stockRow = screen.getByRole("link", { name: "BHP" }).closest("tr")!;
    const detailsRow = stockRow.nextElementSibling as HTMLElement;
    // The details are the stock's own second row: a phone and a tablet read them under the stock, and a full-width row gives
    // the list the width a details list needs (in the Stock cell its tracks shared a few pixels, one letter a line).
    expect(detailsRow).toHaveClass("[@container(min-width:1320px)]:hidden");
    const cell = detailsRow.querySelector("td")!;
    expect(cell).toHaveAttribute("colspan", String(11));
    // The full-width cell pads as every other cell does: 4 px a side, 8 px from sm and 12 px from xl.
    expect(cell).toHaveClass("px-1", "sm:px-2", "xl:px-3");
    expect(cell.querySelector("details")).toBeInTheDocument();
    expect(cellsOf("BHP")[0].querySelector("details")).toBeNull();
    // Below the eleven-column grammar the rule under the stock is the details row's, so the two read as one block.
    expect(stockRow).toHaveClass("border-b-0");
    expect(stockRow).toHaveClass("[@container(min-width:1320px)]:border-b");
    // The two rows take the table's hover tint together: each lights when the other is hovered, so the stock reads as one block.
    expect(stockRow).toHaveClass("[&:has(+tr:hover)]:bg-muted/50");
    expect(detailsRow).toHaveClass("[tr:hover+&]:bg-muted/50");
    // From the eleven-column grammar the last stock is the body's second-to-last child, so it clears its own rule (the body's
    // last-child reset reaches only the hidden details row after it). Every stock row carries the variant;
    // only the last one matches it. CBA is the last stock here.
    expect(screen.getByRole("link", { name: "CBA" }).closest("tr")).toHaveClass("[@container(min-width:1320px)]:[&:nth-last-child(2)]:border-b-0");
    // CBA's stock row comes next, and its own details row after that.
    const cbaDetails = detailsRow.nextElementSibling?.nextElementSibling;
    expect(cbaDetails?.querySelector("summary")).toHaveTextContent("More figures for CBA");
  });

  it("names each row's disclosure after its stock, so a screen reader can tell the rows apart", () => {
    const { container } = table();
    const names = Array.from(container.querySelectorAll("summary"), (summary) => summary.textContent);
    expect(names).toEqual(["More figures for BHP", "More figures for CBA"]);
  });

  it("prints the index and the short figures' dates under the figure from the seven-column grammar, never only in a title", () => {
    const { container } = table();
    // The short date is a muted line the cell shows from the seven-column grammar; below it the row's details carry it.
    const shortLine = cellsOf("BHP")[9].querySelector("time")!.parentElement!;
    expect(shortLine).toHaveTextContent("as of 2026-10-01");
    expect(shortLine).toHaveClass("hidden", "[@container(min-width:980px)]:block", "text-[10px]", "text-muted-foreground");
    expect(cellsOf("BHP")[9]).not.toHaveAttribute("title");
    // The index cell is a column from the seven-column grammar only, so its range is always drawn beside the figure.
    const indexLine = cellsOf("BHP")[6].querySelector("time")!.parentElement!;
    expect(indexLine).toHaveClass("text-[10px]", "text-muted-foreground");
    expect(indexLine).toHaveTextContent("as at 2026-09-30 to 2026-10-01");
    expect(cellsOf("BHP")[6]).not.toHaveAttribute("title");
    expect(cellsOf("CBA")[9].querySelector("time")).toBeNull();
    expect(cellsOf("CBA")[6].querySelector("time")).toBeNull();
    const dl = container.querySelector("details")!.querySelector("dl")!;
    expect(dl).toHaveTextContent("as at 2026-09-30 to 2026-10-01");
    expect(dl.querySelector('time[datetime="2026-09-30"]')).toBeInTheDocument();
    expect(dl.querySelector('time[datetime="2026-10-01"]')).toBeInTheDocument();
  });

  it("draws the measures that are columns from the seven-column grammar, and from the eleven-column one the four that are columns only then, and the four it always shows", () => {
    table();
    for (const label of ["Institutions", "Index funds", "Super value"]) {
      expect(head(label)).toHaveClass("hidden", "[@container(min-width:980px)]:table-cell");
      expect(head(label)).not.toHaveClass("[@container(min-width:1320px)]:table-cell");
    }
    for (const label of ["Interests", "Banks, brokers", "Hedge + active", "Super options"]) {
      expect(head(label)).toHaveClass("hidden", "[@container(min-width:1320px)]:table-cell");
    }
    for (const label of ["Stock", "Disclosed", "Short", "Latest notice"]) {
      expect(head(label)).not.toHaveClass("hidden");
    }
  });

  it("shows each column's cells at the widths its head shows at, so no value is drawn where its head is hidden", () => {
    table();
    // A cell and its head share their visibility classes at every column: a cell shown where its head is hidden would
    // draw a value with no label, and a head shown over a hidden cell would label nothing.
    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(11);
    for (const name of ["BHP", "CBA"]) {
      const cells = cellsOf(name);
      expect(cells).toHaveLength(11);
      headers.forEach((header, index) => {
        expect(showClasses(cells[index]!).sort()).toEqual(showClasses(header).sort());
      });
    }
  });

  it("draws the industry under the code only from the seven-column grammar, and in the details below it", () => {
    table();
    const industry = within(cellsOf("BHP")[0]).getByText("Materials");
    expect(industry.tagName).toBe("SPAN");
    // Capped at the name's width, so the longest industry cannot set the Stock column: it wraps within the cap.
    expect(industry).toHaveClass("hidden", "[@container(min-width:980px)]:block", "[@container(min-width:980px)]:max-w-[14rem]");
    const details = screen.getByRole("link", { name: "BHP" }).closest("tr")!.nextElementSibling!;
    expect(within(details as HTMLElement).getByText("Materials")).toBeInTheDocument();
  });

  it("reads the container's width for its grammars at two thresholds only, and its wrapper is the container", () => {
    const { container } = table();
    // The grammars read the table's own width: 980 px for the seven-column grammar and 1,320 px for the eleven-column one.
    expect(container.firstElementChild).toHaveClass("[container-type:inline-size]");
    const thresholds = new Set(Array.from(container.innerHTML.matchAll(/\[@container\(min-width:(\d+)px\)\]/g), (match) => match[1]));
    expect(Array.from(thresholds).sort()).toEqual(["1320", "980"]);
  });

  it("is never red or green", () => {
    const { container } = table();
    expect(container.innerHTML).not.toMatch(/\b(?:text|bg|border|fill|stroke|decoration)-(?:red|green)|#EF4444|#22C55E/i);
  });

  it("sizes the four columns a phone always draws for 264 px: 4 px a side, 8 px from sm, 12 px from xl, 11 px heads and date, a 12 px code, a name that wraps below the seven-column grammar and a date that does not", () => {
    table();
    for (const label of ["Stock", "Disclosed", "Short", "Latest notice"]) {
      expect(head(label)).toHaveClass("px-1", "sm:px-2", "xl:px-3", "text-[11px]", "sm:text-sm");
    }
    // The code is the stock's link, and below sm it takes the 12 px its company name takes.
    expect(screen.getByRole("link", { name: "BHP" })).toHaveClass("text-xs", "sm:text-sm");
    // A table cell sizes to its longest unbreakable word, unless the word can break anywhere:
    // break-words does not lower that width, overflow-wrap: anywhere does. Below the seven-column grammar the name is
    // the full-width row's, and it never truncates: a phone shows the whole company.
    const [, belowSeven] = screen.getAllByText("BHP Group");
    expect(belowSeven).toHaveClass("[overflow-wrap:anywhere]", "[@container(min-width:980px)]:hidden");
    expect(belowSeven).not.toHaveClass("truncate");
    expect(cellsOf("BHP")[10]).toHaveClass("whitespace-nowrap", "px-1", "sm:px-2", "xl:px-3", "text-[11px]", "sm:text-sm");
  });

  it("keeps every date in the register list on one line: each time is whole, and a range wraps only between its words", () => {
    const { container } = table();
    const times = Array.from(container.querySelectorAll("time"));
    // Latest notice, the short date and the index range, in the columns and in the details: every one of them.
    expect(times.length).toBeGreaterThanOrEqual(6);
    for (const time of times) {
      expect(time).toHaveClass("whitespace-nowrap");
    }
    // The index range is a Dated line: its text is the sentence, and each date inside it is its own time.
    expect(cellsOf("BHP")[6].querySelectorAll("time")).toHaveLength(2);
  });

  it("draws the sort arrow on the sorted head only, so an unsorted head takes no gap for one", () => {
    table({ ...defaultRegistersQuery(), sort: "disclosed", ascending: false });
    expect(within(head("Disclosed")).getByRole("link").querySelector("span")).toHaveTextContent("↓");
    expect(within(head("Stock")).getByRole("link").querySelector("span")).toBeNull();
  });
});
