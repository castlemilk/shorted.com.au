/// <reference types="jest" />

import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { FundExposureMapView, fundMatches } from "../fund-exposure-map";
import { fundKindLabel, type FundRow } from "../fund-model";

function fund(key: string, overrides: Partial<FundRow> = {}): FundRow {
  return {
    key: `asx:${key}`,
    ticker: key,
    name: `${key} exposure fund`,
    institutionSlug: "betashares",
    institutionName: "Betashares",
    sourceKind: "etf",
    pooled: false,
    asAt: "2026-10-31",
    sourceUrl: "https://example.com/a200.csv",
    holdings: 198,
    top10Pct: 44.2,
    sectorWeights: [
      { industry: "Banks", weightPct: 30 },
      { industry: "Materials", weightPct: 12 },
      { industry: "Insurance", weightPct: 4 },
    ],
    largest: [{ code: "CBA", name: "Commonwealth Bank", weightPct: 9.1 }],
    aumAud: null,
    ...overrides,
  };
}

const FUNDS = [
  fund("A200"),
  fund("IOZ", { institutionName: "iShares" }),
  fund("VAS", { institutionName: "Vanguard", pooled: true }),
  fund("STW", { institutionName: "State Street" }),
  fund("HVST", { sourceKind: "super_phd", institutionName: "Hostplus" }),
];

function renderView(search: string, navigate = jest.fn()) {
  const params = new URLSearchParams(search);
  render(
    <FundExposureMapView funds={FUNDS} params={params} pathname="/ownership/funds" navigate={navigate} />,
  );
  return navigate;
}

describe("the fund exposure map (spec 14.3, Funds)", () => {
  it("keys the heat scale in a legend beneath the map", () => {
    renderView("");
    expect(screen.getByRole("heading", { name: "Fund exposure map" })).toBeInTheDocument();
    expect(screen.getByText("Cell colour and value = weight within that fund")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("≥ 40%")).toBeInTheDocument();
  });

  it("puts the search and the four selects in the one toolbar row, labelled in sentence case", () => {
    const { container } = render(
      <FundExposureMapView funds={FUNDS} params={new URLSearchParams("")} pathname="/ownership/funds" navigate={jest.fn()} />,
    );
    const rows = container.querySelectorAll("[data-toolbar]");
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    const search = screen.getByRole("searchbox", { name: "Find fund, code or manager" });
    expect(search).toHaveAttribute("placeholder", "A200, Vanguard, Betashares");
    expect(search).toHaveClass("h-8", "font-mono", "text-xs", "w-40", "max-w-[16rem]", "truncate");
    expect(search).not.toHaveClass("flex-1");
    expect(search.closest("[data-toolbar]")).toBe(row);
    for (const name of ["Manager", "Kind", "View", "Files"]) {
      const select = screen.getByRole("combobox", { name });
      expect(select.tagName).toBe("SELECT");
      expect(select.closest("[data-toolbar]")).toBe(row);
    }
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByText("Fund type")).not.toBeInTheDocument();
  });

  it("offers the kinds, views and files under the names the toolbar prints", () => {
    renderView("");
    const optionsOf = (name: string) =>
      Array.from((screen.getByRole("combobox", { name }) as HTMLSelectElement).options).map((option) => option.textContent);
    expect(optionsOf("Kind")).toEqual(["Index", "Super"]);
    expect(optionsOf("View")).toEqual(["Sector weights", "Holdings"]);
    expect(optionsOf("Files")).toEqual(["Available", "All tracked"]);
    expect(optionsOf("Manager")).toEqual(["All managers", "Betashares", "State Street", "Vanguard", "iShares"]);
  });

  it("writes each select's parameter through the URL, and the default value writes none", () => {
    const navigate = jest.fn();
    render(<FundExposureMapView funds={FUNDS} params={new URLSearchParams("")} pathname="/ownership/funds" navigate={navigate} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Manager" }), { target: { value: "Vanguard" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?manager=Vanguard");
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "super" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?type=super");
    fireEvent.change(screen.getByRole("combobox", { name: "View" }), { target: { value: "holdings" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?view=holdings");
    fireEvent.change(screen.getByRole("combobox", { name: "Files" }), { target: { value: "all" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?coverage=all");
  });

  it("writes no parameter when a select returns to its default", () => {
    const navigate = jest.fn();
    const params = new URLSearchParams("manager=Vanguard&type=super&view=holdings&coverage=all");
    render(<FundExposureMapView funds={FUNDS} params={params} pathname="/ownership/funds" navigate={navigate} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Manager" }), { target: { value: "" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?type=super&view=holdings&coverage=all");
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "index" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?manager=Vanguard&view=holdings&coverage=all");
    fireEvent.change(screen.getByRole("combobox", { name: "View" }), { target: { value: "sectors" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?manager=Vanguard&type=super&coverage=all");
    fireEvent.change(screen.getByRole("combobox", { name: "Files" }), { target: { value: "files" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?manager=Vanguard&type=super&view=holdings");
  });

  it("holds each fund's one line: logo, ticker, tag and manager, in a 44 px row", () => {
    renderView("");
    const link = screen.getByRole("link", { name: "A200 ETF Betashares" });
    expect(link.tagName).toBe("A");
    expect(link.className).toMatch(/\bflex\b/);
    expect(link.className).toMatch(/\bitems-center\b/);
    expect(link.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(link.querySelector("div")).toBeNull();
    const manager = within(link).getByText("Betashares");
    expect(manager).toHaveAttribute("title", "Betashares");
    expect(manager.className).toMatch(/\btruncate\b/);
    expect(manager.className).toMatch(/\btext-muted-foreground\b/);
    expect(within(link).getByText("ETF")).toBeInTheDocument();
    expect(within(link).getByText("A200").className).toMatch(/\btext-foreground\b/);
    expect(link.closest("tr")).toHaveClass("h-11");
  });

  it("centres the chevron and the compare box in the 44 px row, as the row's own cells", () => {
    renderView("");
    const row = screen.getByRole("link", { name: "A200 ETF Betashares" }).closest("tr") as HTMLElement;
    expect(row.className).toMatch(/\[&>td\]:align-middle/);
    expect(within(row).getByRole("button", { name: "Show A200 sector weights and largest positions" })).toBeInTheDocument();
    expect(within(row).getByLabelText("Compare A200")).toBeInTheDocument();
  });

  it("labels the fund column with its ticker and manager", () => {
    renderView("");
    expect(screen.getByRole("columnheader", { name: "Fund (ticker · manager)" })).toBeInTheDocument();
  });

  it("writes the compare selection so a super option's comma survives the round trip", () => {
    const navigate = jest.fn();
    const params = new URLSearchParams([
      ["type", "super"],
      ["funds", "aware/High Growth%2C Balanced"],
    ]);
    render(
      <FundExposureMapView
        funds={[...FUNDS, fund("aware/High Growth, Balanced", { sourceKind: "super_phd", institutionName: "Aware" })]}
        params={params}
        pathname="/ownership/funds"
        navigate={navigate}
      />,
    );
    expect(screen.getByRole("region", { name: "Selected funds" })).toHaveTextContent("1 fund selected");
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare HVST" }));
    const written = new URLSearchParams({ type: "super", funds: "aware/High Growth%2C Balanced,asx:HVST" });
    expect(navigate).toHaveBeenCalledWith(`/ownership/funds?${written.toString()}`);
  });

  it("lists the index funds, with the six sector columns, an Other column and the as-at date", () => {
    renderView("");
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((th) => th.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(["Banks", "Materials", "Insurance", "Other", "As at"]));
    expect(screen.queryByText("Hostplus")).not.toBeInTheDocument();
    expect(within(table).getByText("Betashares")).toBeInTheDocument();
    expect(screen.getAllByText("2026-10-31").length).toBeGreaterThan(0);
  });

  it("shows the super options when the type is super, and no ETF", () => {
    renderView("type=super");
    expect(screen.getAllByText("Hostplus").length).toBeGreaterThan(0);
    expect(screen.getByText("Super option")).toBeInTheDocument();
    expect(screen.queryByText("Betashares")).not.toBeInTheDocument();
  });

  it("prints a sector weight to one decimal, and Other as a true 0.0% when the file lists nothing outside the columns", () => {
    renderView("");
    const row = screen.getByText("A200").closest("tr");
    expect(within(row!).getByText("30.0%")).toBeInTheDocument();
    expect(within(row!).getByText("0.0%")).toBeInTheDocument();
    expect(within(row!).queryByText("n/a")).not.toBeInTheDocument();
  });

  it("ticks a fund into the compare selection, through the URL", () => {
    const navigate = renderView("");
    fireEvent.click(screen.getByLabelText("Compare A200"));
    expect(navigate).toHaveBeenCalledWith("/ownership/funds?funds=asx%3AA200");
  });

  it("caps the comparison at two: a third tick replaces the oldest ticked fund, and no box is disabled", () => {
    const navigate = renderView("funds=asx:A200,asx:IOZ");
    expect(screen.getByLabelText("Compare STW")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Compare STW"));
    expect(navigate).toHaveBeenCalledWith("/ownership/funds?funds=asx%3AIOZ%2Casx%3ASTW");
    expect(screen.getByLabelText("Compare A200")).toBeEnabled();
  });

  it("writes a tick past the cap in tick order, the newest last", () => {
    const navigate = renderView("funds=asx:IOZ,asx:STW");
    fireEvent.click(screen.getByLabelText("Compare VAS"));
    expect(navigate).toHaveBeenCalledWith("/ownership/funds?funds=asx%3ASTW%2Casx%3AVAS");
  });

  it("draws the bottom bar with the selected funds and the link to compare them", () => {
    renderView("funds=asx:A200,asx:IOZ");
    const bar = screen.getByRole("region", { name: "Selected funds" });
    expect(within(bar).getByText("2 funds selected")).toBeInTheDocument();
    expect(within(bar).getByRole("link", { name: "Compare portfolios →" })).toHaveAttribute(
      "href",
      "/ownership/changes?fund=asx%3AA200",
    );
  });

  it("switches to the holdings view, one row per largest position", () => {
    renderView("view=holdings");
    const links = screen.getAllByRole("link", { name: "CBA" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      expect.arrayContaining(["/ownership/funds?view=holdings&sel=holding%3Aasx%3AA200%2FCBA"]),
    );
  });

  it("selects a fund for the inspector through its link", () => {
    renderView("");
    expect(screen.getByRole("link", { name: "A200 ETF Betashares" })).toHaveAttribute("href", "/ownership/funds?sel=fund%3Aasx%3AA200");
  });

  it("filters by the search across code, name and manager", () => {
    renderView("");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find fund, code or manager" }), { target: { value: "ishares" } });
    expect(screen.getByText("IOZ")).toBeInTheDocument();
    expect(screen.queryByText("A200")).not.toBeInTheDocument();
  });

  it("names the kind of a fund as its badge does", () => {
    expect(fundKindLabel(fund("X"))).toBe("ETF");
    expect(fundKindLabel(fund("X", { pooled: true }))).toBe("Pooled");
    expect(fundKindLabel(fund("X", { sourceKind: "super_phd" }))).toBe("Super option");
    expect(fundMatches(fund("A200"), "betashares")).toBe(true);
    expect(fundMatches(fund("A200"), "zzz")).toBe(false);
  });
});

describe("the fund exposure map's controls and expanders (spec 14.1, 14.3)", () => {
  it("narrows the funds to one manager, through the URL", () => {
    renderView("manager=Vanguard");
    const table = screen.getByRole("table");
    expect(within(table).getByText("VAS")).toBeInTheDocument();
    expect(within(table).queryByText("A200")).not.toBeInTheDocument();
  });

  it("hides a fund with no file until the coverage asks for every tracked fund", () => {
    const bare = fund("NOFILE", { asAt: "", sourceUrl: "" });
    const { unmount } = render(
      <FundExposureMapView funds={[fund("A200"), bare]} params={new URLSearchParams("")} pathname="/ownership/funds" navigate={jest.fn()} />,
    );
    expect(screen.queryByText("NOFILE")).not.toBeInTheDocument();
    unmount();
    render(
      <FundExposureMapView funds={[fund("A200"), bare]} params={new URLSearchParams("coverage=all")} pathname="/ownership/funds" navigate={jest.fn()} />,
    );
    expect(screen.getByText("NOFILE")).toBeInTheDocument();
  });

  it("opens each fund's figures through its own expander, closed at first", () => {
    renderView("");
    const trigger = screen.getByRole("button", { name: "Show A200 sector weights and largest positions" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Top 10 holdings").length).toBeGreaterThan(0);
  });

  it("says nothing of a one-fund reading once two are selected, and asks for one more tick with one", () => {
    renderView("funds=asx:A200,asx:IOZ");
    expect(screen.queryByText(/reads one fund/)).toBeNull();
    expect(screen.queryByText("Tick one more to compare them.")).toBeNull();
  });

  it("asks for one more tick when a single fund is selected", () => {
    renderView("funds=asx:A200");
    expect(screen.getByRole("region", { name: "Selected funds" })).toHaveTextContent("1 fund selected");
    expect(screen.getByText("Tick one more to compare them.")).toBeInTheDocument();
  });
});


/** Index funds with a largest sector change, one with none (IOZ), and a super option the kind filter hides. */
const MOVED = [
  fund("A200", { largestSectorChangePp: -2.5, largestSectorChangeSector: "Banks" }),
  fund("IOZ", { institutionName: "iShares" }),
  fund("VAS", { institutionName: "Vanguard", pooled: true, largestSectorChangePp: 10.2, largestSectorChangeSector: "Banks" }),
  fund("STW", { institutionName: "State Street", largestSectorChangePp: 0.5, largestSectorChangeSector: "Materials" }),
  fund("HVST", { sourceKind: "super_phd", institutionName: "Hostplus", largestSectorChangePp: 40, largestSectorChangeSector: "Banks" }),
];

/** The fund rows' checkboxes in the order the table draws them, named by their fund. */
function rowOrder(): string[] {
  return screen.getAllByRole("checkbox").map((box) => (box.getAttribute("aria-label") ?? "").replace("Compare ", ""));
}

describe("the fund exposure map's sort (backlog C3b)", () => {
  it("orders the rows by the largest sector change under Changed, the rows with none last in the API's order", () => {
    render(<FundExposureMapView funds={MOVED} params={new URLSearchParams("sort=changed")} pathname="/ownership/funds" navigate={jest.fn()} />);
    expect(rowOrder()).toEqual(["VAS", "A200", "STW", "IOZ"]);
  });

  it("keeps the API's order under Largest", () => {
    render(<FundExposureMapView funds={MOVED} params={new URLSearchParams("")} pathname="/ownership/funds" navigate={jest.fn()} />);
    expect(rowOrder()).toEqual(["A200", "IOZ", "VAS", "STW"]);
  });

  it("names the sector and its change after the manager under Changed, with a true minus", () => {
    render(<FundExposureMapView funds={MOVED} params={new URLSearchParams("sort=changed")} pathname="/ownership/funds" navigate={jest.fn()} />);
    expect(screen.getByText("Banks +10.20 pp")).toBeInTheDocument();
    expect(screen.getByText("Banks −2.50 pp")).toBeInTheDocument();
    expect(screen.getByText("Materials +0.50 pp")).toBeInTheDocument();
    // The fund that states no change carries no detail, not a dash or a zero.
    expect(screen.getAllByText(/ pp$/)).toHaveLength(3);
  });

  it("carries no change detail under Largest", () => {
    render(<FundExposureMapView funds={MOVED} params={new URLSearchParams("")} pathname="/ownership/funds" navigate={jest.fn()} />);
    expect(screen.queryByText(/ pp$/)).toBeNull();
  });

  it("draws the Sort select in the toolbar's one row, showing the sort the URL names", () => {
    const { container } = render(
      <FundExposureMapView funds={MOVED} params={new URLSearchParams("sort=changed")} pathname="/ownership/funds" navigate={jest.fn()} />,
    );
    expect(container.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    const select = screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement;
    expect(select.value).toBe("changed");
    expect(select.closest("[data-toolbar]")).toBe(container.querySelector("[data-toolbar]"));
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Largest", "Changed"]);
  });

  it("navigates to the sort it is set to, and drops the parameter for Largest", () => {
    const navigate = jest.fn();
    render(<FundExposureMapView funds={MOVED} params={new URLSearchParams("sort=changed&type=super")} pathname="/ownership/funds" navigate={navigate} />);
    const select = screen.getByRole("combobox", { name: "Sort" });
    fireEvent.change(select, { target: { value: "largest" } });
    expect(navigate).toHaveBeenLastCalledWith("/ownership/funds?type=super");
  });

  it("draws the server's default view on Largest, as the toolbar's other selects draw their defaults", () => {
    const host = document.createElement("div");
    host.innerHTML = markupOf("", MOVED);
    const select = Array.from(host.querySelectorAll("select")).find((el) => el.querySelector('option[value="changed"]'));
    expect(select).toBeDefined();
    expect(select?.value).toBe("largest");
  });
});

/** The server's markup of the default view: React writes each inline style itself, so the stops are read as written. */
function markupOf(search = "", funds: FundRow[] = FUNDS): string {
  return renderToStaticMarkup(
    <FundExposureMapView funds={funds} params={new URLSearchParams(search)} pathname="/ownership/funds" navigate={jest.fn()} />,
  );
}

describe("the fund exposure map's ramp (spec 13.1, backlog A2)", () => {
  it("shades a cell by the desk's weight stop, and prints its figure in that stop's ink", () => {
    const markup = markupOf();
    // 30% is the fourth of the five 8-point bins: the stop and its ink are theme tokens, never a mix.
    expect(markup).toMatch(/<td[^>]*style="background:hsl\(var\(--desk-bin-3\)\);color:hsl\(var\(--desk-bin-ink-3\)\)"[^>]*>30\.0%<\/td>/);
    expect(markup).not.toMatch(/<td[^>]*style="[^"]*"[^>]*>n\/a<\/td>/);
  });

  it("leaves a sector the fund states no weight for plain: no fill and no ink, never a tinted zero", () => {
    // Materials is a column sector this fund states no weight for; the other funds state all three.
    const markup = markupOf("", [
      ...FUNDS,
      fund("NUL", {
        sectorWeights: [
          { industry: "Banks", weightPct: 30 },
          { industry: "Materials", weightPct: null },
          { industry: "Insurance", weightPct: 4 },
        ],
      }),
    ]);
    // The default view shows five funds (the super option is filtered out). Every sector lies in a column, so each
    // fund's Other is a true 0.0% (its file holds nothing outside them), and the only n/a left is the new fund's
    // stated-null Materials cell, the one unstyled n/a.
    expect(markup.match(/<td class="px-2 py-2 text-right tabular-nums">0\.0%<\/td>/g)).toHaveLength(5);
    expect(markup.match(/<td class="px-2 py-2 text-right tabular-nums">n\/a<\/td>/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<td[^>]*style="[^"]*"[^>]*>n\/a<\/td>/);
  });

  it("keys the legend with the five stops of the same scale, from the paper to the deepest stop", () => {
    const markup = markupOf();
    for (let bin = 0; bin < 5; bin += 1) {
      expect(markup).toContain(`class="h-3 w-6 border border-border" style="background:hsl(var(--desk-bin-${bin}))"`);
    }
  });
});
