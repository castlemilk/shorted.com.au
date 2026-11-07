import {
  COMPARE_LIMIT,
  DEFAULT_FILTERS,
  EXPLORER_COPY,
  SHORT_PROFILE,
  buildExplorerModel,
  cellsOf,
  compareCandidates,
  compareHref,
  evidenceKindOf,
  filterRows,
  fiscalYearOf,
  horizonKey,
  liveMetric,
  notComputableCells,
  parseIds,
  parseSelection,
  parseWindow,
  pickOption,
  registryStrategy,
  shortDate,
  toggleId,
  universeOf,
  utcClock,
  windowMetrics,
  yearsOf,
  type ExplorerRow,
} from "../explorer";
import { mapListStrategyEvidence, mapStrategyEvidence } from "../map-backtest";
import { DEFS, EVIDENCE, EVIDENCE_INPUT } from "./backtest-fixtures";
import { STRATEGY_SLUGS } from "../registry";

const NOW = new Date(Date.UTC(2026, 10, 7));
const model = (today?: Parameters<typeof buildExplorerModel>[0]["today"]) =>
  buildExplorerModel({ strategies: DEFS, evidence: EVIDENCE, now: NOW, today });
const row = (id: string, m = model()) => m.rows.find((r) => r.id === id)!;
const ids = (rows: ExplorerRow[]) => rows.map((r) => r.id);

describe("the map-backtest mapper (design 8.2)", () => {
  it("passes the contract's state names through, without aliases", () => {
    expect(mapStrategyEvidence({ state: "published" }).state).toBe("published");
    expect(mapStrategyEvidence({ state: "computed" }).state).toBe("computed");
    expect(mapStrategyEvidence({ state: "run_required" }).state).toBe("run_required");
  });

  it("maps a zero without its has_ flag to null, never to 0", () => {
    const window = mapStrategyEvidence({
      strategyId: "x",
      windows: [{ window: "trailing_12m", cagrPct: 0, hasCagr: false, totalReturnPct: 4.2, sharpe: 0, hasSharpe: false }],
    }).windows[0]!;
    expect(window.cagrPct).toBeNull();
    expect(window.totalReturnPct).toBe(4.2);
    expect(window.sharpe).toBeNull();
  });

  it("reads the annual coverage as a fraction, under its measure, and only when measurable", () => {
    const list = mapListStrategyEvidence({
      strategies: [{ strategyId: "x", annual: [
        { year: 2019, strategyPct: 1, coveragePct: 64.2, coverageMeasurable: true, coverageMeasure: "qualifying_5pct_short" },
        { year: 2020, strategyPct: 1, coveragePct: 90, coverageMeasurable: false },
      ] }],
    });
    expect(list.strategies[0]!.annual[0]!.coverage).toBeCloseTo(0.642);
    expect(list.strategies[0]!.annual[0]!.coverageMeasure).toBe("qualifying_5pct_short");
    expect(list.strategies[0]!.annual[1]!.coverage).toBeNull();
  });

  it("keeps the state reason, the running start, the computable share and the paper track's recorded start", () => {
    const ev = mapStrategyEvidence({
      state: "running",
      stateReason: "a reason",
      runningSince: "2026-11-07T14:02:00Z",
      computableSharePct: 41.6,
      hasComputableShare: true,
      paper: { since: "2026-11-23", recordedFrom: "2026-11-24", sessions: 3 },
    });
    expect(ev).toMatchObject({ stateReason: "a reason", runningSince: "2026-11-07T14:02:00Z", computableSharePct: 41.6 });
    expect(ev.paper?.recordedFrom).toBe("2026-11-24");
    expect(mapStrategyEvidence({ computableSharePct: 41.6 }).computableSharePct).toBeNull();
  });

  it("reads a bigint run id as a number", () => {
    expect(mapStrategyEvidence({ runId: BigInt(42) }).runId).toBe(42);
  });
});

describe("the years and the columns", () => {
  it("runs from 2019 to the newest year, the first column from 1 May and the to-date year as YTD", () => {
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

describe("the coverage marker and line (1.7)", () => {
  it("draws a figure's coverage line with the low-coverage copy as its title", () => {
    const cell = row("crowded-short-breakout").cells[0]!;
    expect(cell).toMatchObject({ state: "value", value: 15.9, coverage: 0.642 });
    expect(cell).toHaveProperty("coverageTitle", EXPLORER_COPY.lowCoverage(64));
  });

  it("marks Minervini's unmeasurable years '?' and nothing else", () => {
    const cells = row("minervini-trend-template").cells;
    for (const cell of cells.slice(0, 6)) {
      expect(cell).toMatchObject({ state: "value", marker: { glyph: "?", label: EXPLORER_COPY.measuredOnAsic } });
      expect(cell).toHaveProperty("coverage", null);
    }
  });

  it("shows no '?' on a measurable all-ASX year, and carries its coverage", () => {
    const cells = row("minervini-trend-template").cells;
    const measurable = cells[6]!;
    expect(measurable).toMatchObject({ state: "value", value: 13.5, coverage: 0.97 });
    expect(measurable).not.toHaveProperty("marker");
    expect(cells[7]).not.toHaveProperty("marker");
  });
});

describe("the not-computable split (computable_from decides, the label is copy)", () => {
  const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

  it("splits a June filer's row at computable_from: FY2024 from 30 September 2024", () => {
    const cells = row("zanger-breakout").cells;
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ state: "hatched", label: "Not computable before FY2024", span: 5 });
    expect(cells[1]).toEqual({ state: "hatched", label: EXPLORER_COPY.approximateNotPublished, span: 3 });
    expect(cells.reduce((sum, c) => sum + (c.state === "hatched" && c.span ? c.span : 1), 0)).toBe(8);
  });

  it("splits a December filer's row at its own computable_from: FY2023 computable from 28 March 2024", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", state: "not_computable", fiscalLabel: "FY2023", computableFrom: "2024-03-28" });
    const cells = notComputableCells(ev, years);
    expect(cells[0]).toMatchObject({ label: "Not computable before FY2023", span: 5 });
    expect(cells[1]).toMatchObject({ label: EXPLORER_COPY.approximateNotPublished, span: 3 });
  });

  it("falls back to the label's year only when computable_from is empty", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", state: "not_computable", fiscalLabel: "FY2025" });
    expect(notComputableCells(ev, years)[0]).toMatchObject({ label: "Not computable before FY2025", span: 6 });
  });

  it("names the 1.7 second sentence on the merged cell, as its title", () => {
    const cell = row("zanger-breakout").cells[0]!;
    expect(cell).toHaveProperty("title", EXPLORER_COPY.notComputableSecond("FY2024"));
  });

  it("reads a row with no label and no computable_from as one span, with the measured share", () => {
    expect(row("quality-compounders").cells).toEqual([
      {
        state: "hatched",
        label: "Not computable: needs point-in-time fundamentals (fundamentals for 42% of the universe)",
        span: 8,
      },
    ]);
  });

  it("reads the fiscal year from a label", () => {
    expect(fiscalYearOf("FY2024")).toBe(2024);
    expect(fiscalYearOf("")).toBeNull();
  });
});

describe("the other states, one span per row", () => {
  it("merges running into one span with the start in UTC (h23)", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", state: "running", runningSince: "2026-11-07T14:02:00Z" });
    expect(cellsOf(ev, [2024, 2025, 2026], 2019, true)).toEqual([
      { state: "hatched", label: "Running since 14:02 UTC", span: 3 },
    ]);
    expect(utcClock("2026-11-07T00:05:00Z")).toBe("00:05 UTC");
  });

  it("keeps run required per year, and reads its reason in the rail", () => {
    const m = model();
    const cells = cellsOf(mapStrategyEvidence({ strategyId: "x", state: "run_required" }), [2024, 2025], 2019, true);
    expect(cells).toEqual([
      { state: "hatched", label: "Run required" },
      { state: "hatched", label: "Run required" },
    ]);
    expect(m.rows.length).toBe(5);
  });

  it("merges a missing row into one span: 'No evidence published' while the read works, no text when it failed", () => {
    expect(cellsOf(null, [2024, 2025], 2019, true)).toEqual([{ state: "hatched", label: "No evidence published", span: 2 }]);
    expect(cellsOf(null, [2024, 2025], 2019, false)).toEqual([{ state: "hatched", label: "", span: 2 }]);
  });

  it("marks years before a row's own first year 'Before window', and after its data 'Not elapsed'", () => {
    const ev = mapStrategyEvidence({
      strategyId: "x",
      state: "published",
      annual: [{ year: 2021, state: "complete", strategyPct: 3, coverageMeasurable: false }],
    });
    const cells = cellsOf(ev, [2019, 2020, 2021, 2022], 2019, true);
    expect(cells[0]).toEqual({ state: "hatched", label: EXPLORER_COPY.beforeWindow });
    expect(cells[1]).toEqual({ state: "hatched", label: EXPLORER_COPY.beforeWindow });
    expect(cells[2]).toMatchObject({ state: "value", value: 3 });
    expect(cells[3]).toEqual({ state: "hatched", label: EXPLORER_COPY.notElapsed });
  });
});

describe("the metric columns and the Live column", () => {
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

  it("reads the Live column as the tracking date while too short, from the track's recorded start", () => {
    expect(liveMetric(EVIDENCE.strategies[0]!)).toEqual({ key: "live", text: "Tracking since 23 Nov 2026", value: null, note: "Recorded" });
    expect(liveMetric(EVIDENCE.strategies[1]!)).toEqual({ key: "live", text: "n/a", value: null });
  });

  it("labels a long paper track's return as recorded, from its actual start", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", paper: { since: "2026-01-02", recordedFrom: "2026-01-05", sessions: 200, closedTrades: 15, returnPct: 4.4, hasReturn: true, tooShort: false } });
    expect(liveMetric(ev)).toEqual({ key: "live", text: "+4.4%", value: 4.4, note: "Recorded since 5 Jan 2026" });
  });
});

describe("the Live column never prints a label without its date", () => {
  const paperWith = (over: Record<string, unknown>) =>
    mapStrategyEvidence({
      strategyId: "x",
      paper: { sessions: 10, closedTrades: 2, returnPct: 1.8, hasReturn: false, tooShort: true, since: "2026-11-23", recordedFrom: "2026-11-24", ...over },
    });

  it("reads n/a for a row with no paper track, and for a track with no start", () => {
    expect(liveMetric(mapStrategyEvidence({ strategyId: "x" }))).toEqual({ key: "live", text: "n/a", value: null });
    expect(liveMetric(mapStrategyEvidence({ strategyId: "x", paper: {} }))).toEqual({ key: "live", text: "n/a", value: null });
  });

  it("uses the track's actual start when recorded_from is empty and since is set, and never prints an empty date", () => {
    const ev = paperWith({ recordedFrom: "" });
    expect(liveMetric(ev)).toEqual({ key: "live", text: "Tracking since 23 Nov 2026", value: null, note: "Recorded" });
  });

  it("reads an RFC 3339 timestamp as its day", () => {
    expect(liveMetric(paperWith({ recordedFrom: "2026-11-24T09:30:00+11:00" })).text).toBe("Tracking since 24 Nov 2026");
  });

  it("reads garbage as no date: n/a, not an empty label", () => {
    expect(liveMetric(paperWith({ recordedFrom: "not-a-date", since: "" }))).toEqual({ key: "live", text: "n/a", value: null });
    expect(liveMetric(paperWith({ recordedFrom: "2026-13-45", since: "garbage" }))).toEqual({ key: "live", text: "n/a", value: null });
  });

  it("prints a long track's return as recorded from its actual start", () => {
    expect(liveMetric(paperWith({ tooShort: false, hasReturn: true, returnPct: 4.4, sessions: 200 }))).toEqual({
      key: "live",
      text: "+4.4%",
      value: 4.4,
      note: "Recorded since 24 Nov 2026",
    });
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
    const bare = buildExplorerModel({ strategies: STRATEGY_SLUGS.map(registryStrategy), evidence: null, now: NOW });
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
    expect(m.rows[0]!.cells[0]).toEqual({ state: "hatched", label: "", span: 8 });
    expect(m.rows[0]!.inspector.emptyLabel).toBe("Backtest unavailable right now");
    expect(m.rows[0]!.inspector.stateLine).toBe("Backtest unavailable right now");
  });

  it("adds a strategy the evidence names but the list does not", () => {
    const extra = { ...EVIDENCE_INPUT, strategies: [...EVIDENCE_INPUT.strategies!, { strategyId: "new-one", state: "run_required" }] };
    const m = buildExplorerModel({ strategies: DEFS, evidence: mapListStrategyEvidence(extra), now: NOW });
    expect(m.rows.at(-1)!.id).toBe("new-one");
    expect(m.rows.at(-1)!.name).toBe("new-one");
  });

  it("gives each row the short profile in the mockup's form, and the Daily evaluation chip from the cadence", () => {
    expect(row("crowded-short-breakout").sublabel).toBe("Short crowding · days-weeks");
    expect(row("minervini-trend-template").sublabel).toBe("Trend · weeks-months");
    expect(SHORT_PROFILE["quality-compounders"]).toBe("Quality · months-years");
    expect(row("crowded-short-breakout").inspector.chips).toEqual(["Long entries", "Daily evaluation"]);
    expect(row("crowded-short-breakout").inspector.sparkLabel).toBe("Backtest, in-sample to 23 Nov 2026, then recorded");
  });

  it("reads the rail's counts and session from the picks when they are given, and the evidence otherwise", () => {
    const picks = model({ "crowded-short-breakout": { counts: { triggered: 7, setup: 9, watch: 1, unknown: 0 }, asOf: "2026-11-06" } });
    expect(row("crowded-short-breakout", picks).inspector.countsText).toBe("7 triggered · 9 setups");
    expect(row("crowded-short-breakout", picks).inspector.latestScreen).toBe("6 Nov 2026");
    expect(row("crowded-short-breakout").inspector.countsText).toBe("5 triggered · 66 setups");
  });

  it("carries the survivorship statement and the state's copy into the rail", () => {
    const crowded = row("crowded-short-breakout").inspector;
    expect(crowded.survivorship).toContain("Flatters results");
    expect(row("zanger-breakout").inspector.stateLine).toContain("Not computable before FY2024");
    expect(row("quality-compounders").inspector.emptyLabel).toBe("Not computable");
  });

  it("names the rail's no-curve copy by state", () => {
    const run = buildExplorerModel({
      strategies: DEFS,
      evidence: mapListStrategyEvidence({ strategies: [{ strategyId: "crowded-short-breakout", state: "run_required", stateReason: "No recipe is published for this version yet" }] }),
      now: NOW,
    });
    const r = run.rows.find((x) => x.id === "crowded-short-breakout")!;
    expect(r.inspector.emptyLabel).toBe("Run required");
    expect(r.inspector.stateLine).toBe("No recipe is published for this version yet");
  });
});

describe("the filters", () => {
  it("keeps every row with no filter set", () => {
    expect(filterRows(model().rows, DEFAULT_FILTERS)).toHaveLength(5);
  });

  it("searches the name, the author and the style", () => {
    const rows = model().rows;
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "zanger" }))).toEqual(["zanger-breakout"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "  O'NEIL " }))).toEqual(["canslim"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "nothing like this" }))).toEqual([]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "short squeeze" }))).toEqual(["crowded-short-breakout"]);
  });

  it("filters by style and horizon, on stable keys", () => {
    const rows = model().rows;
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, style: "trend-following" }))).toEqual(["minervini-trend-template"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, horizon: "years" }))).toEqual(["quality-compounders"]);
    expect(horizonKey("Weeks to months")).toBe("weeks-to-months");
    expect(horizonKey("Days to weeks")).toBe("days-to-weeks");
  });

  it("the ASX universe lists every strategy; ASIC-reported names narrows to them", () => {
    const rows = model().rows;
    expect(filterRows(rows, { ...DEFAULT_FILTERS, universe: "asx" })).toHaveLength(5);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, universe: "asic" }))).toEqual(["crowded-short-breakout"]);
    expect(DEFAULT_FILTERS.universe).toBe("asx");
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

  it("reads the universe from the text the strategy prints, in one place", () => {
    expect(universeOf("ASX equities; a reported short position of at least 5% to trigger")).toBe("asic");
    expect(universeOf("ASX equities with at least 60 sessions")).toBe("asx");
  });

  it("validates a URL value against the options it names, falling back to the default", () => {
    const styles = model().styles;
    expect(pickOption("trend-following", styles, "all")).toBe("trend-following");
    expect(pickOption("bogus", styles, "all")).toBe("all");
    expect(pickOption("asic", [{ value: "asx" }, { value: "asic" }], "asx")).toBe("asic");
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

  it("links the comparison in the order picked, and offers the registry's strategies", () => {
    expect(compareHref(["canslim", "zanger-breakout"])).toBe("/strategies/compare?ids=canslim,zanger-breakout");
    expect(compareCandidates().map((c) => c.id)).toEqual(STRATEGY_SLUGS);
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
