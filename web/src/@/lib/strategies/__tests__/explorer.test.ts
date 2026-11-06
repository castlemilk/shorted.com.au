import {
  COMPARE_LIMIT,
  DEFAULT_FILTERS,
  EXPLORER_COPY,
  buildExplorerModel,
  cellsOf,
  compareHref,
  evidenceKindOf,
  filterRows,
  fiscalYearOf,
  liveMetric,
  parseIds,
  parseSelection,
  parseWindow,
  registryStrategy,
  shortDate,
  toggleId,
  universeOf,
  windowMetrics,
  yearsOf,
  type ExplorerRow,
} from "../explorer";
import { mapListStrategyEvidence, mapStrategyEvidence } from "../map-backtest";
import { DEFS, EVIDENCE, EVIDENCE_INPUT } from "./backtest-fixtures";
import { STRATEGY_SLUGS } from "../registry";

const NOW = new Date(Date.UTC(2026, 10, 7));
const model = () => buildExplorerModel({ strategies: DEFS, evidence: EVIDENCE, now: NOW });
const row = (id: string, m = model()) => m.rows.find((r) => r.id === id)!;

describe("the map-backtest mapper", () => {
  it("maps a zero without its has_ flag to null, never to 0", () => {
    const window = mapStrategyEvidence({
      strategyId: "x",
      windows: [{ window: "trailing_12m", cagrPct: 0, hasCagr: false, totalReturnPct: 4.2, sharpe: 0, hasSharpe: false }],
    }).windows[0]!;
    expect(window.cagrPct).toBeNull();
    expect(window.totalReturnPct).toBe(4.2);
    expect(window.sharpe).toBeNull();
  });

  it("reads the annual coverage as a fraction, and only when the year is measurable", () => {
    const list = mapListStrategyEvidence({
      strategies: [{ strategyId: "x", annual: [
        { year: 2019, strategyPct: 1, coveragePct: 64.2, coverageMeasurable: true },
        { year: 2020, strategyPct: 1, coveragePct: 90, coverageMeasurable: false },
      ] }],
    });
    expect(list.strategies[0]!.annual[0]!.coverage).toBeCloseTo(0.642);
    expect(list.strategies[0]!.annual[1]!.coverage).toBeNull();
  });

  it("keeps the freeze date and the paper track's flags", () => {
    const ev = EVIDENCE.strategies.find((s) => s.strategyId === "crowded-short-breakout")!;
    expect(ev.version?.liveFrom).toBe("2026-11-23");
    expect(ev.paper).toMatchObject({ since: "2026-11-23", tooShort: true, returnPct: null });
    expect(ev.runId).toBe(8);
  });

  it("reads the names PR-18 sends today as the design 8.2 vocabulary, and passes others through", () => {
    const ev = mapStrategyEvidence({
      strategyId: "x",
      state: "computed",
      windows: [{ window: "since_may_2019" }, { window: "live_since_freeze" }, { window: "trailing_12m" }],
    });
    expect(ev.state).toBe("published");
    expect(ev.windows.map((w) => w.window)).toEqual(["since_2019_05", "live", "trailing_12m"]);
    expect(mapStrategyEvidence({ state: "run_required" }).state).toBe("run_required");
  });

  it("reads a bigint run id as a number", () => {
    expect(mapStrategyEvidence({ runId: BigInt(42) }).runId).toBe(42);
  });
});

describe("the years and the columns", () => {
  it("runs from the window's first year to the newest, with the first column from 1 May and the current year as YTD", () => {
    const { years, columns } = yearsOf(EVIDENCE, NOW);
    expect(years).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(columns[0]).toMatchObject({ key: "y2019", label: "2019", note: "from 1 May" });
    expect(columns[1]!.note).toBeUndefined();
    expect(columns[7]!.label).toBe("2026 YTD");
  });

  it("opens on the canonical 2019 and runs to the current year when nothing is published", () => {
    const { years } = yearsOf(null, NOW);
    expect(years[0]).toBe(2019);
    expect(years[years.length - 1]).toBe(2026);
  });
});

describe("the heatmap states, per row", () => {
  it("prints the computed years as values, with coverage under 80% hatched by the table", () => {
    const cells = row("crowded-short-breakout").cells;
    expect(cells).toHaveLength(8);
    expect(cells[0]).toMatchObject({ state: "value", value: 15.9, coverage: 0.642 });
    expect(cells[7]).toMatchObject({ state: "value", value: 9.1, coverage: 0.96 });
  });

  it("gives the current year its YTD figure, not 'Not elapsed'", () => {
    const cell = row("crowded-short-breakout").cells[7]!;
    expect(cell.state).toBe("value");
  });

  it("marks a year measured on ASIC-reported names with a ? and no coverage line", () => {
    const cells = row("minervini-trend-template").cells;
    expect(cells[0]).toMatchObject({
      state: "value",
      marker: { glyph: "?", label: EXPLORER_COPY.measuredOnAsic },
    });
    expect(cells[0]).not.toHaveProperty("coverage", expect.any(Number));
  });

  it("merges the years before the fiscal label into one cell and reads the rest as approximate-not-published", () => {
    const cells = row("zanger-breakout").cells;
    expect(cells[0]).toEqual({ state: "hatched", label: "Not computable before FY2024", span: 5 });
    expect(cells.slice(1)).toEqual([
      { state: "hatched", label: EXPLORER_COPY.approximateNotPublished },
      { state: "hatched", label: EXPLORER_COPY.approximateNotPublished },
      { state: "hatched", label: EXPLORER_COPY.approximateNotPublished },
    ]);
    // 5 merged + 3 later = 8 year columns, so the spans add up to the table's width.
    const width = cells.reduce((sum, c) => sum + (c.state === "hatched" && c.span ? c.span : 1), 0);
    expect(width).toBe(8);
  });

  it("reads a not-computable row with no fiscal label as one hatched cell with the no-label copy", () => {
    expect(row("quality-compounders").cells).toEqual([
      { state: "hatched", label: EXPLORER_COPY.notComputable, span: 8 },
    ]);
  });

  it("names the measured share of the universe when a no-label row is not computable (design 1.7)", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", state: "not_computable", computableSharePct: 41.6, hasComputableShare: true });
    expect(cellsOf(ev, [2024, 2025], 2019, true)).toEqual([
      { state: "hatched", label: "Not computable: needs point-in-time fundamentals (fundamentals for 42% of the universe)", span: 2 },
    ]);
  });

  it("carries the API's state reason into the rail, never the fundamentals copy for a run that is only waiting on a recipe", () => {
    const m = buildExplorerModel({
      strategies: DEFS,
      evidence: mapListStrategyEvidence({
        strategies: [{ strategyId: "crowded-short-breakout", state: "run_required", stateReason: "No recipe is published for this version yet" }],
      }),
      now: NOW,
    });
    const r = m.rows.find((x) => x.id === "crowded-short-breakout")!;
    expect(r.cells[0]).toEqual({ state: "hatched", label: "Run required" });
    expect(r.inspector.stateLine).toBe("No recipe is published for this version yet");
  });

  it("reads run required, running and an unknown state as their own cell copy", () => {
    const years = [2024, 2025];
    expect(cellsOf({ ...EVIDENCE.strategies[0]!, state: "run_required", annual: [] }, years, 2019, true)).toEqual([
      { state: "hatched", label: "Run required" },
      { state: "hatched", label: "Run required" },
    ]);
    expect(cellsOf({ ...EVIDENCE.strategies[0]!, state: "running", annual: [] }, years, 2019, true)[0]).toEqual({
      state: "hatched",
      label: "Running",
    });
    expect(cellsOf({ ...EVIDENCE.strategies[0]!, state: "mystery", annual: [] }, years, 2019, true)[0]).toEqual({
      state: "hatched",
      label: EXPLORER_COPY.notPublished,
    });
  });

  it("names the state of a row with no evidence, and says so when the evidence read failed", () => {
    expect(cellsOf(null, [2024], 2019, true)[0]).toEqual({ state: "hatched", label: EXPLORER_COPY.notPublished });
    expect(cellsOf(null, [2024], 2019, false)[0]).toEqual({ state: "hatched", label: EXPLORER_COPY.unavailable });
  });

  it("gives an unmeasured year before the window 'Before window' and after the data 'Not elapsed'", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", state: "published", annual: [{ year: 2021, state: "complete", strategyPct: 3 }] });
    // The window opens in 2021: 2019 and 2020 are before it; 2022 has no figure yet.
    const cells = cellsOf(ev, [2019, 2020, 2021, 2022], 2021, true);
    expect(cells[0]).toEqual({ state: "hatched", label: EXPLORER_COPY.beforeWindow });
    expect(cells[1]).toEqual({ state: "hatched", label: EXPLORER_COPY.beforeWindow });
    expect(cells[2]).toMatchObject({ state: "value", value: 3 });
    expect(cells[3]).toEqual({ state: "hatched", label: EXPLORER_COPY.notElapsed });
  });
});

describe("the fiscal label", () => {
  it("reads FY2024 as 2024", () => {
    expect(fiscalYearOf("FY2024")).toBe(2024);
    expect(fiscalYearOf("")).toBeNull();
  });
});

describe("the metric columns", () => {
  it("prints the CAGR when the window is a year or more", () => {
    const [cagr, dd] = windowMetrics(EVIDENCE.strategies[0]!, "since_2019_05");
    expect(cagr).toMatchObject({ key: "cagr", text: "+15.6%", value: 15.6 });
    expect(cagr!.note).toBeUndefined();
    expect(dd).toMatchObject({ key: "maxdd", text: "−18.6%", value: -18.6 });
  });

  it("prints the total return marked not annualised when the window is under a year", () => {
    const [cagr] = windowMetrics(EVIDENCE.strategies[0]!, "live");
    expect(cagr).toMatchObject({ text: "+1.8%", note: EXPLORER_COPY.totalNotAnnualised });
  });

  it("prints n/a for a strategy with no window", () => {
    expect(windowMetrics(EVIDENCE.strategies[2]!, "since_2019_05")).toEqual([
      { key: "cagr", text: "n/a", value: null },
      { key: "maxdd", text: "n/a", value: null },
    ]);
  });

  it("reads the Live column as the paper return, or the date tracking began while too short", () => {
    expect(liveMetric(EVIDENCE.strategies[0]!)).toEqual({ key: "live", text: "Tracking since 23 Nov 2026", value: null });
    expect(liveMetric(EVIDENCE.strategies[1]!)).toEqual({ key: "live", text: "n/a", value: null });
  });

  it("shows a long paper track's return", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", paper: { since: "2026-01-02", sessions: 200, closedTrades: 15, returnPct: 4.4, hasReturn: true, tooShort: false } });
    expect(liveMetric(ev)).toEqual({ key: "live", text: "+4.4%", value: 4.4 });
  });
});

describe("the explorer model", () => {
  it("lists the strategies in registry order, with names from the registry when the list read failed", () => {
    expect(model().rows.map((r) => r.id)).toEqual([
      "zanger-breakout",
      "canslim",
      "minervini-trend-template",
      "crowded-short-breakout",
      "quality-compounders",
    ]);
    const bare = buildExplorerModel({ strategies: [], evidence: EVIDENCE, now: NOW });
    expect(bare.rows.find((r) => r.id === "canslim")!.name).toBe("CAN SLIM");
  });

  it("names every registry strategy when no list was read, so the table is never empty", () => {
    const bare = buildExplorerModel({
      strategies: STRATEGY_SLUGS.map(registryStrategy),
      evidence: null,
      now: NOW,
    });
    expect(bare.rows.map((r) => r.name)).toEqual([
      "Zanger Breakout",
      "CAN SLIM",
      "Minervini Trend Template",
      "Crowded-Short Breakout",
      "Quality compounders",
    ]);
    expect(bare.rows.every((r) => r.cells.length > 0)).toBe(true);
  });

  it("opens on the Crowded-Short strategy when it is listed", () => {
    expect(model().defaultId).toBe("crowded-short-breakout");
  });

  it("chips the shared freeze date and the range line with the benchmark", () => {
    const m = model();
    expect(m.chipLabel).toBe("Backtests · in-sample to 23 Nov 2026");
    expect(m.rangeLine).toContain("1 May 2019 to 6 Nov 2026");
    expect(m.rangeLine).toContain("benchmark S&P/ASX 200 Gross TR (XJT)");
    expect(m.footnotes).toHaveLength(2);
  });

  it("says the evidence is unavailable and still lists the strategies", () => {
    const m = buildExplorerModel({ strategies: DEFS, evidence: null, now: NOW });
    expect(m.evidenceAvailable).toBe(false);
    expect(m.rows).toHaveLength(5);
    expect(m.rows[0]!.cells[0]).toEqual({ state: "hatched", label: EXPLORER_COPY.unavailable });
  });

  it("adds a strategy the evidence names but the list does not", () => {
    const extra = { ...EVIDENCE_INPUT, strategies: [...EVIDENCE_INPUT.strategies!, { strategyId: "new-one", state: "run_required" }] };
    const m = buildExplorerModel({ strategies: DEFS, evidence: mapListStrategyEvidence(extra), now: NOW });
    expect(m.rows.at(-1)!.id).toBe("new-one");
    expect(m.rows.at(-1)!.name).toBe("new-one");
  });

  it("builds a sublabel of style and horizon, and the Daily evaluation chip from the cadence", () => {
    const r = row("crowded-short-breakout");
    expect(r.sublabel).toBe("Short squeeze breakout · days to weeks");
    expect(r.inspector.chips).toEqual(["Long entries", "Daily evaluation"]);
    expect(r.inspector.sparkLabel).toBe("Backtest, in-sample to 23 Nov 2026, then recorded");
  });

  it("offers the styles and horizons its strategies carry", () => {
    const m = model();
    expect(m.styles.map((o) => o.value)).toEqual(["all", "growth-momentum", "momentum-breakout", "quality", "short-squeeze-breakout", "trend-following"]);
    expect(m.horizons.map((o) => o.value)).toContain("Days to weeks");
  });
});

describe("the filters", () => {
  const ids = (rows: ExplorerRow[]) => rows.map((r) => r.id);

  it("keeps every row with no filter set", () => {
    expect(filterRows(model().rows, DEFAULT_FILTERS)).toHaveLength(5);
  });

  it("searches the name, the author and the style", () => {
    const rows = model().rows;
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "zanger" }))).toEqual(["zanger-breakout"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "  O'NEIL " }))).toEqual(["canslim"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "nothing like this" }))).toEqual([]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "william" }))).toEqual(["canslim"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "short squeeze" }))).toEqual(["crowded-short-breakout"]);
  });

  it("filters by style, horizon and universe", () => {
    const rows = model().rows;
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, style: "trend-following" }))).toEqual(["minervini-trend-template"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, horizon: "Years" }))).toEqual(["quality-compounders"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, universe: "asic" }))).toEqual(["crowded-short-breakout"]);
    expect(filterRows(rows, { ...DEFAULT_FILTERS, universe: "asx" })).toHaveLength(4);
  });

  it("filters by evidence: backtested, approximate, live track only", () => {
    const rows = model().rows;
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, evidence: "backtested" }))).toEqual(["minervini-trend-template", "crowded-short-breakout"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, evidence: "approximate" }))).toEqual([]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, evidence: "live" }))).toEqual([]);
  });

  it("classifies a row's evidence from its state and paper track", () => {
    expect(evidenceKindOf(null)).toBe("none");
    expect(evidenceKindOf(mapStrategyEvidence({ state: "approximate" }))).toBe("approximate");
    expect(evidenceKindOf(mapStrategyEvidence({ state: "not_computable", paper: { sessions: 12 } }))).toBe("live");
  });

  it("reads the universe from the text the strategy prints", () => {
    expect(universeOf("ASX equities with at least 60 sessions; a reported short position of at least 5% to trigger")).toBe("asic");
    expect(universeOf("ASX equities with at least 60 sessions")).toBe("asx");
  });
});

describe("the selection and the compare tray", () => {
  const rows = model().rows;

  it("reads ?sel= as a strategy, and falls back to the default", () => {
    expect(parseSelection("strategy:canslim", rows, "crowded-short-breakout")).toBe("canslim");
    expect(parseSelection("strategy:nope", rows, "crowded-short-breakout")).toBe("crowded-short-breakout");
    expect(parseSelection("stock:BHP", rows, "zanger-breakout")).toBe("zanger-breakout");
    expect(parseSelection(null, rows, null)).toBeNull();
  });

  it("keeps only known ids in ?ids=, unique and at most the limit", () => {
    expect(parseIds("canslim,nope,canslim,zanger-breakout,quality-compounders,minervini-trend-template", rows)).toEqual([
      "canslim",
      "zanger-breakout",
      "quality-compounders",
    ]);
    expect(parseIds(null, rows)).toEqual([]);
  });

  it("never holds more than three: a fourth tick is ignored", () => {
    let picked: string[] = [];
    for (const id of ["zanger-breakout", "canslim", "minervini-trend-template", "quality-compounders"]) {
      picked = toggleId(picked, id);
    }
    expect(picked).toHaveLength(COMPARE_LIMIT);
    expect(picked).not.toContain("quality-compounders");
    expect(toggleId(picked, "canslim")).toEqual(["zanger-breakout", "minervini-trend-template"]);
  });

  it("links the comparison in the order picked", () => {
    expect(compareHref(["canslim", "zanger-breakout"])).toBe("/strategies/compare?ids=canslim,zanger-breakout");
  });

  it("reads the window from ?window= and defaults to since May 2019", () => {
    expect(parseWindow("since_2023")).toBe("since_2023");
    expect(parseWindow("bogus")).toBe("since_2019_05");
  });
});

describe("dates", () => {
  it("prints a short day, and nothing for an empty or invalid day", () => {
    expect(shortDate("2026-11-03")).toBe("3 Nov 2026");
    expect(shortDate("")).toBe("");
    expect(shortDate("not-a-date")).toBe("");
  });
});
