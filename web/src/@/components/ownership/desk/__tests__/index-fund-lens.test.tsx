import { render, screen } from "@testing-library/react";

import type { OwnershipMapPage } from "~/app/actions/ownershipDesk";
import { binOf, lensScale, lensFill } from "../desk-scales";
import { DEFAULT_DESK_STATE, DESK_LENSES, readDeskState, writeDeskState } from "../desk-state";
import { formatFundChangePct, formatLensFigure, LENS_LABELS, LENS_SELECT_LABELS, mapCaption } from "../lens-legend";
import { layoutMap, lensFigure, type MapStockRow } from "../map-layout";
import { mapSizeOf } from "../ownership-map";
import {
  NO_FIGURE_COPY,
  OwnershipMapView,
  sizedRows,
  undrawnAtSize,
  undrawnAtSizeCopy,
} from "../ownership-map-static";

function stock(overrides: Partial<MapStockRow> & { code: string }): MapStockRow {
  return {
    name: `${overrides.code} Ltd`,
    industry: "Materials",
    marketCap: 1_000,
    disclosedPct: 10,
    institutionalPct: 6,
    hedgePct: 2,
    indexPct: 4,
    shortPct: 3,
    flowPp: 0.5,
    fundValueAud: null,
    fundFlowAud: null,
    fundChangePct: null,
    notices: 2,
    ...overrides,
  };
}

const ROWS: MapStockRow[] = [
  stock({ code: "BHP", marketCap: 300_000, fundValueAud: 900_000_000, fundChangePct: 2.5 }),
  stock({ code: "RIO", marketCap: 200_000, fundValueAud: 300_000_000, fundChangePct: -1.25 }),
  stock({ code: "CBA", marketCap: 150_000, fundValueAud: null, fundChangePct: null }),
];

function page(overrides: Partial<OwnershipMapPage> = {}): OwnershipMapPage {
  return {
    ok: true,
    error: "",
    from: "2026-07-14",
    to: "2026-10-12",
    asOf: "2026-10-12",
    stocks: ROWS,
    fundsCompared: 2,
    startFilesFrom: "2026-08-03",
    startFilesTo: "2026-08-03",
    endFilesFrom: "2026-10-30",
    endFilesTo: "2026-10-30",
    ...overrides,
  };
}

describe("the index fund change lens (spec 14.10)", () => {
  it("is one of the desk's lenses, reached from a link and written back to it", () => {
    expect(DESK_LENSES).toContain("index_flow");
    expect(readDeskState(new URLSearchParams("lens=index_flow")).lens).toBe("index_flow");
    expect(writeDeskState({ ...DEFAULT_DESK_STATE, lens: "index_flow" })).toBe("lens=index_flow");
  });

  it("reads the fund change as its figure, and an absent change as no figure, never zero", () => {
    expect(lensFigure(ROWS[0]!, "index_flow")).toBe(2.5);
    expect(lensFigure(ROWS[2]!, "index_flow")).toBeNull();
  });

  it("draws the change on the diverging, five-bin scale, mirrored about zero", () => {
    const scale = lensScale("index_flow", ROWS.map((row) => lensFigure(row, "index_flow")));
    expect(scale.mode).toBe("diverging");
    expect(scale.lo).toBe(-2 * scale.step);
    expect(scale.hi).toBe(2 * scale.step);
    // A fall and a rise of one size fall in mirrored bins.
    // The step is 2 here: 2.5 is past one step and short of two, so it is the second bin either side.
    expect(scale.step).toBe(2);
    expect(binOf(-2.5, scale)).toBe(1);
    expect(binOf(2.5, scale)).toBe(3);
    expect(binOf(-5, scale)).toBe(0);
    expect(binOf(5, scale)).toBe(4);
    expect(binOf(0.1, scale)).toBe(2);
    expect(lensFill(null, scale)).toBeNull();
  });

  it("hatches a stock with no fund change, and draws every other stock's figure", () => {
    const layout = layoutMap(ROWS, { width: 1000, height: 560, lens: "index_flow" });
    expect(layout.cells.find((cell) => cell.code === "CBA")).toMatchObject({ hatched: true, value: null });
    expect(layout.cells.find((cell) => cell.code === "BHP")).toMatchObject({ hatched: false, value: 2.5 });
  });

  it("prints its figure as a signed percentage with a true minus, and n/a without one", () => {
    expect(formatFundChangePct(2.5)).toBe("+2.50%");
    expect(formatFundChangePct(-1.25)).toBe("−1.25%");
    expect(formatFundChangePct(0.001)).toBe("0.00%");
    expect(formatFundChangePct(null)).toBe("n/a");
    expect(formatLensFigure("index_flow", -0.5)).toBe("−0.50%");
  });

  it("is named in the colour control and the legend, and its caption says what it compares", () => {
    expect(LENS_LABELS.index_flow).toBe("Change in index fund shares");
    expect(LENS_SELECT_LABELS.index_flow).toBe("Index fund shares");
    expect(mapCaption("index_flow")).toMatch(/valued at the later file's price/);
  });
});

describe("the index fund holdings size (spec 14.10)", () => {
  it("is selectable beside the market cap and the disclosed exposure", () => {
    expect(mapSizeOf("index_fund")).toBe("index_fund");
    expect(mapSizeOf("disclosed")).toBe("disclosed");
    expect(mapSizeOf("market_cap")).toBe("market_cap");
    expect(mapSizeOf("anything else")).toBe("market_cap");
  });

  it("draws only the stocks a tracked fund holds, at their AUD holding", () => {
    const drawn = sizedRows(ROWS, "index_fund");
    expect(drawn.map((row) => row.code)).toEqual(["BHP", "RIO"]);
    expect(drawn.map((row) => row.marketCap)).toEqual([900_000_000, 300_000_000]);
  });

  it("counts the stocks it leaves out, and no others, and words the coverage line with the count", () => {
    expect(undrawnAtSize(ROWS, "index_fund")).toBe(1);
    expect(undrawnAtSize(ROWS, "market_cap")).toBe(0);
    expect(undrawnAtSizeCopy(1, 3)).toBe(
      "Index fund holdings: 1 of 3 stocks are not drawn at this size, because no tracked index fund holds them.",
    );
  });

  it("says so in the map's coverage line when the size leaves stocks out", () => {
    render(<OwnershipMapView page={page()} desk={{ ...DEFAULT_DESK_STATE }} status="idle" slow={false} basePath="/ownership/map" size="index_fund" />);
    expect(screen.getByText(/Index fund holdings: 1 of 3 stocks are not drawn at this size/)).toBeInTheDocument();
  });

  it("draws no such line at the market cap, where every stock is drawn", () => {
    render(<OwnershipMapView page={page()} desk={{ ...DEFAULT_DESK_STATE }} status="idle" slow={false} basePath="/ownership/map" size="market_cap" />);
    expect(screen.queryByText(/not drawn at this size/)).toBeNull();
  });

  it("captions its area as the funds' holding, not the market cap", () => {
    render(<OwnershipMapView page={page()} desk={{ ...DEFAULT_DESK_STATE }} status="idle" slow={false} basePath="/ownership/map" size="index_fund" />);
    expect(screen.getByText(/Area is the holding of the tracked index funds, in AUD at the window's end file/)).toBeInTheDocument();
  });
});

describe("the index fund change in the map view", () => {
  it("draws the change lens and its stepped legend", () => {
    render(
      <OwnershipMapView page={page()} desk={{ ...DEFAULT_DESK_STATE, lens: "index_flow" }} status="idle" slow={false} basePath="/ownership/map" />,
    );
    expect(screen.getByRole("img", { name: /Change in index fund shares, five steps/ })).toBeInTheDocument();
  });

  it("states that no stock has a figure when no fund is compared, rather than drawing zeros", () => {
    const none = ROWS.map((row) => ({ ...row, fundChangePct: null }));
    render(
      <OwnershipMapView
        page={page({ stocks: none, fundsCompared: 0 })}
        desk={{ ...DEFAULT_DESK_STATE, lens: "index_flow" }}
        status="idle"
        slow={false}
        basePath="/ownership/map"
      />,
    );
    expect(screen.getByText(NO_FIGURE_COPY)).toBeInTheDocument();
  });

  it("hatches a held answer's fund change while a new window is read, as it does the flow", () => {
    const { container } = render(
      <OwnershipMapView page={page()} desk={{ ...DEFAULT_DESK_STATE, lens: "index_flow" }} status="loading" slow={false} basePath="/ownership/map" />,
    );
    expect(container.textContent).toContain(NO_FIGURE_COPY);
  });
});
