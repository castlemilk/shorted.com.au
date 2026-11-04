/// <reference types="jest" />

import { fireEvent, render, screen, within } from "@testing-library/react";
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
  it("titles the map beside its view toggle, and keys the heat scale in a legend", () => {
    renderView("");
    const title = screen.getByRole("heading", { name: "Fund exposure map" });
    const row = title.parentElement as HTMLElement;
    expect(within(row).getByRole("radiogroup", { name: "Table view" })).toBeInTheDocument();
    expect(screen.getByText("Cell colour and value = weight within that fund")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("≥ 40%")).toBeInTheDocument();
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

  it("prints a sector weight to one decimal, n/a where the fund states none", () => {
    renderView("");
    const row = screen.getByText("A200").closest("tr");
    expect(within(row!).getByText("30.0%")).toBeInTheDocument();
    expect(within(row!).getByText("n/a")).toBeInTheDocument();
  });

  it("ticks a fund into the compare selection, through the URL", () => {
    const navigate = renderView("");
    fireEvent.click(screen.getByLabelText("Compare A200"));
    expect(navigate).toHaveBeenCalledWith("/ownership/funds?funds=asx%3AA200");
  });

  it("disables a fourth tick once three are selected", () => {
    renderView("funds=asx:A200,asx:IOZ,asx:VAS");
    expect(screen.getByLabelText("Compare STW")).toBeDisabled();
    expect(screen.getByLabelText("Compare A200")).toBeChecked();
    expect(screen.getByLabelText("Compare A200")).toBeEnabled();
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
    expect(screen.getByRole("link", { name: /^A200 .*Betashares$/ })).toHaveAttribute("href", "/ownership/funds?sel=fund%3Aasx%3AA200");
  });

  it("filters by the search across code, name and manager", () => {
    renderView("");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ishares" } });
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

  it("says the comparison reads one fund when more than one is selected", () => {
    renderView("funds=asx:A200,asx:IOZ");
    expect(screen.getByText("The comparison reads one fund: A200.")).toBeInTheDocument();
  });
});
