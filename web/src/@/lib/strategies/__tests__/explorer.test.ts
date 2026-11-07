// The explorer model, on the protojson goldens (./golden) through the shared mapper. Every
// expectation is derived from the golden or from a constant the golden determines; a
// regenerated golden must not need an edit here.
import {
  COMPARE_LIMIT,
  DEFAULT_FILTERS,
  EXPLORER_COPY,
  SHORT_PROFILE,
  buildExplorerModel,
  cellsOf,
  compareCandidates,
  compareHref,
  epochOf,
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
import { mapStrategyEvidence, mapStrategyEvidenceList } from "../map-backtest";
import { DEFS, EVIDENCE, EVIDENCE_RAW, GOLDEN_IDS, GOLDEN_PRICES_YEAR, GOLDEN_START_YEAR, rowIdIn } from "./golden-explorer";
import { STRATEGY_SLUGS } from "../registry";

// The golden's own clock: the table's newest year is the year its prices run to.
const NOW = new Date(`${EVIDENCE.pricesThrough}T12:00:00Z`);
const model = (today?: Parameters<typeof buildExplorerModel>[0]["today"]) =>
  buildExplorerModel({ strategies: DEFS, evidence: EVIDENCE, now: NOW, today });
const row = (id: string, m = model()) => m.rows.find((r) => r.id === id)!;
const ids = (rows: ExplorerRow[]) => rows.map((r) => r.id);
const golden = (id: string) => EVIDENCE_RAW.strategies!.find((s) => s.strategyId === id)!;
const shared = (id: string) => EVIDENCE.strategies.find((s) => s.strategyId === id)!;

describe("the golden feeds the shared mapper", () => {
  it("reads the golden's rows in the order the API serves them, with the universe kind as the contract names it", () => {
    expect(GOLDEN_IDS).toEqual(EVIDENCE_RAW.strategies!.map((s) => s.strategyId));
    for (const id of GOLDEN_IDS) {
      expect(["asic_reported", "asx_ordinary", ""]).toContain(shared(id).universeKind);
    }
    expect(shared("crowded-short-breakout").universeKind).toBe(golden("crowded-short-breakout").universeKind);
  });

  it("keeps the golden's coverage in percent on the shared view", () => {
    const annual = golden("crowded-short-breakout").annual!;
    expect(shared("crowded-short-breakout").annual[0]!.coveragePct).toBe(annual[0]!.coveragePct);
  });
});

describe("the years and the columns", () => {
  it("runs from the golden's window start to the year its prices reach, with the first column from 1 May", () => {
    const { years, columns } = yearsOf(EVIDENCE, NOW);
    expect(years[0]).toBe(GOLDEN_START_YEAR);
    expect(years[years.length - 1]).toBe(GOLDEN_PRICES_YEAR);
    expect(columns[0]).toMatchObject({ key: `y${GOLDEN_START_YEAR}`, label: String(GOLDEN_START_YEAR), note: "from 1 May" });
  });

  it("labels the to-date year YTD, from the golden's own to-date period", () => {
    const { columns } = yearsOf(EVIDENCE, NOW);
    const toDate = EVIDENCE.strategies.flatMap((s) => s.annual).find((a) => a.state === "to_date");
    expect(toDate).toBeDefined();
    expect(columns.at(-1)!.label).toBe(`${toDate!.year} ${EXPLORER_COPY.ytd}`);
  });

  it("opens on the canonical start year and runs to the current year when nothing is published", () => {
    const { years } = yearsOf(null, NOW);
    expect(years[0]).toBe(2019);
    expect(years[years.length - 1]).toBe(NOW.getUTCFullYear());
  });
});

describe("the coverage marker and line (1.7), from percent", () => {
  it("draws a published year's coverage as a fraction, with the low-coverage copy as its title", () => {
    const id = rowIdIn("published");
    const annual = shared(id).annual.find((a) => a.coverageMeasurable && a.coveragePct !== null)!;
    const cell = row(id).cells[annual.year - GOLDEN_START_YEAR] as Extract<(typeof row extends never ? never : ReturnType<typeof cellsOf>)[number], { state: "value" }>;
    expect(cell).toMatchObject({ state: "value", coverage: annual.coveragePct! / 100 });
    expect(cell).toHaveProperty("coverageTitle", EXPLORER_COPY.lowCoverage(Math.round(annual.coveragePct!)));
  });

  it("marks every not-measurable year '?' and gives it no coverage line", () => {
    const id = "minervini-trend-template";
    const unmeasured = shared(id).annual.filter((a) => !a.coverageMeasurable);
    expect(unmeasured.length).toBeGreaterThan(0);
    for (const a of unmeasured) {
      const cell = row(id).cells[a.year - GOLDEN_START_YEAR] as { marker?: { glyph: string }; coverage?: unknown };
      expect(cell.marker?.glyph).toBe("?");
      expect(cell.coverage).toBeNull();
    }
  });

  it("shows no '?' on a measurable year, whatever its measure", () => {
    const id = "minervini-trend-template";
    const measurable = shared(id).annual.filter((a) => a.coverageMeasurable);
    expect(measurable.length).toBeGreaterThan(0);
    for (const a of measurable) {
      const cell = row(id).cells[a.year - GOLDEN_START_YEAR] as { marker?: unknown };
      expect(cell).not.toHaveProperty("marker");
    }
  });
});

describe("the not-computable split (computable_from decides, the label is copy)", () => {
  const years = Array.from({ length: 8 }, (_, i) => GOLDEN_START_YEAR + i);
  const zanger = shared("zanger-breakout");

  it("splits the golden's row at its computable_from year, with its label as copy", () => {
    const cf = Number(zanger.computableFrom!.slice(0, 4));
    const before = years.filter((y) => y < cf).length;
    const cells = notComputableCells(zanger, years);
    expect(cells[0]).toMatchObject({ state: "hatched", label: `Not computable before ${zanger.fiscalLabel}`, span: before });
    expect(cells[1]).toMatchObject({ state: "hatched", label: EXPLORER_COPY.approximateNotPublished, span: years.length - before });
    expect(cells.reduce((sum, c) => sum + (c.state === "hatched" && c.span ? c.span : 1), 0)).toBe(years.length);
  });

  it("uses the golden's state reason as the cell's second sentence, as its title", () => {
    expect(row("zanger-breakout").cells[0]).toHaveProperty("title", EXPLORER_COPY.notComputableSecond(zanger.fiscalLabel!));
  });

  it("splits at a December filer's own computable_from: the label's year decides only without one", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", state: "not_computable", fiscalLabel: "FY2023", computableFrom: "2024-03-28" });
    expect(notComputableCells(ev, years)[0]).toMatchObject({ label: "Not computable before FY2023", span: 5 });
    const bare = mapStrategyEvidence({ strategyId: "x", state: "not_computable", fiscalLabel: "FY2025" });
    expect(notComputableCells(bare, years)[0]).toMatchObject({ label: "Not computable before FY2025", span: 6 });
  });

  it("reads a row with no label and no computable_from as one span, with the measured share", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", state: "not_computable", computableSharePct: 41.6, hasComputableShare: true });
    expect(notComputableCells(ev, years)).toEqual([
      { state: "hatched", label: `Not computable: needs point-in-time fundamentals (fundamentals for 42% of the universe)`, span: 8 },
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
    expect(cellsOf(ev, [2024, 2025, 2026], 2019, true)).toEqual([{ state: "hatched", label: "Running since 14:02 UTC", span: 3 }]);
    expect(utcClock("2026-11-07T00:05:00Z")).toBe("00:05 UTC");
  });

  it("keeps run required per year", () => {
    const id = rowIdIn("run_required");
    const cells = row(id).cells;
    expect(cells.length).toBe(8);
    expect(cells.every((c) => c.state === "hatched" && c.label === "Run required")).toBe(true);
  });

  it("merges a missing row into one span: 'No evidence published' while the read works, no text when it failed", () => {
    expect(cellsOf(null, [2024, 2025], 2019, true)).toEqual([{ state: "hatched", label: "No evidence published", span: 2 }]);
    expect(cellsOf(null, [2024, 2025], 2019, false)).toEqual([{ state: "hatched", label: "", span: 2 }]);
  });

  it("marks years before a row's own first year 'Before window', and after its data 'Not elapsed'", () => {
    const ev = mapStrategyEvidence({ strategyId: "x", state: "published", annual: [{ year: 2021, state: "complete", strategyPct: 3, coverageMeasurable: false }] });
    const cells = cellsOf(ev, [2019, 2020, 2021, 2022], 2019, true);
    expect(cells[0]).toEqual({ state: "hatched", label: EXPLORER_COPY.beforeWindow });
    expect(cells[2]).toMatchObject({ state: "value", value: 3 });
    expect(cells[3]).toEqual({ state: "hatched", label: EXPLORER_COPY.notElapsed });
  });
});

describe("the metric columns and the Live column, from the golden", () => {
  it("prints the CAGR of a window a year or more long, from the golden's own figure", () => {
    const id = rowIdIn("published");
    const window = shared(id).windows.find((w) => w.window === "since_2019_05")!;
    const [cagr] = windowMetrics(shared(id), "since_2019_05");
    expect(cagr!.value).toBe(window.cagrPct);
    expect(cagr!.text).toMatch(/^[+−]/);
  });

  it("prints the total return marked not annualised for the live window, which is under a year", () => {
    const live = shared("crowded-short-breakout").windows.find((w) => w.window === "live")!;
    const [cagr] = windowMetrics(shared("crowded-short-breakout"), "live");
    expect(cagr).toMatchObject({ value: live.totalReturnPct, note: EXPLORER_COPY.totalNotAnnualised });
  });

  it("prints n/a for a row with no windows", () => {
    expect(windowMetrics(shared("zanger-breakout"), "since_2019_05")).toEqual([
      { key: "cagr", text: "n/a", value: null },
      { key: "maxdd", text: "n/a", value: null },
    ]);
  });

  it("reads the Live column of the golden's track, recorded from its own first session", () => {
    const paper = shared("crowded-short-breakout").paper!;
    const live = liveMetric(shared("crowded-short-breakout"));
    expect(live.text).toBe(`Tracking since ${shortDate(paper.recordedFrom)}`);
    expect(live.note).toBe("Recorded");
  });

  it("reads n/a for a row with no paper track", () => {
    expect(liveMetric(shared("zanger-breakout"))).toEqual({ key: "live", text: "n/a", value: null });
  });
});

describe("the explorer model", () => {
  it("lists the golden's strategies in registry order", () => {
    expect(model().rows.map((r) => r.id)).toEqual(STRATEGY_SLUGS.filter((id) => GOLDEN_IDS.includes(id)));
  });

  it("names every registry strategy when no list was read, so the table is never empty", () => {
    const bare = buildExplorerModel({ strategies: STRATEGY_SLUGS.map(registryStrategy), evidence: null, now: NOW });
    expect(bare.rows.every((r) => r.cells.length > 0)).toBe(true);
    expect(bare.rows.length).toBe(STRATEGY_SLUGS.length);
  });

  it("opens on the Crowded-Short strategy when it is in the golden", () => {
    expect(model().defaultId).toBe("crowded-short-breakout");
  });

  it("chips the freeze date the golden's versions carry, or a plain word when they carry none", () => {
    const m = model();
    const frozen = EVIDENCE.strategies.map((s) => s.version?.liveFrom ?? "").filter(Boolean);
    expect(m.chipLabel).toBe(frozen.length ? `Backtests · in-sample to ${shortDate(frozen[0])}` : "Backtests");
  });

  it("chips the range line with the golden's window, prices and benchmark", () => {
    const m = model();
    expect(m.rangeLine).toContain(`${shortDate(EVIDENCE.windowStart)} to ${shortDate(EVIDENCE.pricesThrough)}`);
    expect(m.rangeLine).toContain(`benchmark ${EVIDENCE.benchmarkName}`);
    expect(m.footnotes).toEqual(EVIDENCE.footnotes);
  });

  it("says the evidence is unavailable and still lists the strategies", () => {
    const m = buildExplorerModel({ strategies: DEFS, evidence: null, now: NOW });
    expect(m.evidenceAvailable).toBe(false);
    expect(m.rows).toHaveLength(DEFS.length);
    expect(m.rows[0]!.cells[0]).toEqual({ state: "hatched", label: "", span: m.columns.length });
    expect(m.rows[0]!.inspector.emptyLabel).toBe("Backtest unavailable right now");
  });

  it("adds a strategy the evidence names but the list does not", () => {
    const extra = { ...EVIDENCE_RAW, strategies: [...EVIDENCE_RAW.strategies!, { strategyId: "new-one", state: "run_required" }] };
    const m = buildExplorerModel({ strategies: DEFS, evidence: mapStrategyEvidenceList(extra), now: NOW });
    expect(m.rows.at(-1)!.id).toBe("new-one");
  });

  it("gives each row the short profile in the mockup's form, and the Daily evaluation chip from the cadence", () => {
    expect(row("crowded-short-breakout").sublabel).toBe(SHORT_PROFILE["crowded-short-breakout"]);
    expect(row("crowded-short-breakout").inspector.chips).toEqual(["Long entries", "Daily evaluation"]);
    // The rail's caption names the freeze date only when the version carries one; the golden's
    // version has none, so the caption is the plain word.
    const frozen = shared("crowded-short-breakout").version?.liveFrom ?? "";
    expect(row("crowded-short-breakout").inspector.sparkLabel).toBe(
      frozen ? `Backtest, in-sample to ${shortDate(frozen)}, then recorded` : "Backtest",
    );
  });

  it("reads the rail's counts and session from the picks when they are given, and the evidence otherwise", () => {
    const picks = model({ "crowded-short-breakout": { counts: { triggered: 7, setup: 9, watch: 1, unknown: 0 }, asOf: "2026-11-06" } });
    expect(row("crowded-short-breakout", picks).inspector.countsText).toBe("7 triggered · 9 setups");
    expect(row("crowded-short-breakout", picks).inspector.latestScreen).toBe("6 Nov 2026");
  });

  it("carries the golden's survivorship statement into the rail", () => {
    expect(row("minervini-trend-template").inspector.survivorship).toBe(shared("minervini-trend-template").survivorship);
  });

  it("uses the state's own copy for a row with no curve", () => {
    expect(row("zanger-breakout").inspector.stateLine).toContain(`Not computable before ${shared("zanger-breakout").fiscalLabel}`);
    const notComputable = GOLDEN_IDS.find((id) => shared(id).state === "not_computable");
    if (notComputable) expect(row(notComputable).inspector.emptyLabel).toBe("Not computable");
    expect(row(rowIdIn("run_required")).inspector.emptyLabel).toBe("Run required");
  });
});

describe("the filters", () => {
  it("keeps every row with no filter set", () => {
    expect(filterRows(model().rows, DEFAULT_FILTERS)).toHaveLength(GOLDEN_IDS.length);
  });

  it("searches the name, the author and the style", () => {
    const rows = model().rows;
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "zanger" }))).toEqual(["zanger-breakout"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "  O'NEIL " }))).toEqual(["canslim"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, query: "nothing like this" }))).toEqual([]);
  });

  it("filters by style and horizon, on stable keys", () => {
    const rows = model().rows;
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, style: "trend-following" }))).toEqual(["minervini-trend-template"]);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, horizon: "years" }))).toEqual(["quality-compounders"]);
    expect(horizonKey("Weeks to months")).toBe("weeks-to-months");
  });

  it("filters the universe on the contract's keys: the golden's ASIC-reported strategy alone", () => {
    const rows = model().rows;
    const asic = GOLDEN_IDS.filter((id) => shared(id).universeKind === "asic_reported");
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, universe: "asic_reported" }))).toEqual(asic);
    // The ASX universe lists every strategy; only ASIC-reported names narrows.
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, universe: "asx_ordinary" }))).toEqual(GOLDEN_IDS);
    expect(DEFAULT_FILTERS.universe).toBe("asx_ordinary");
  });

  it("reads the universe from the evidence's kind, and a row with no evidence as the default", () => {
    expect(universeOf("asic_reported")).toBe("asic_reported");
    expect(universeOf("asx_ordinary")).toBe("asx_ordinary");
    expect(universeOf("")).toBe("asx_ordinary");
  });

  it("filters by evidence: backtested is the golden's published rows, in order", () => {
    const rows = model().rows;
    const published = GOLDEN_IDS.filter((id) => shared(id).state === "published");
    expect(published.length).toBeGreaterThan(0);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, evidence: "backtested" }))).toEqual(published);
    expect(ids(filterRows(rows, { ...DEFAULT_FILTERS, evidence: "approximate" }))).toEqual([]);
  });

  it("classifies a row's evidence from its state and paper track", () => {
    expect(evidenceKindOf(null)).toBe("none");
    expect(evidenceKindOf(mapStrategyEvidence({ state: "approximate" }))).toBe("approximate");
    expect(evidenceKindOf(mapStrategyEvidence({ state: "not_computable", paper: { sessions: 12 } }))).toBe("live");
  });

  it("validates a URL value against the options it names, falling back to the default", () => {
    const styles = model().styles;
    expect(pickOption("trend-following", styles, "all")).toBe("trend-following");
    expect(pickOption("bogus", styles, "all")).toBe("all");
    expect(pickOption("asic_reported", [{ value: "asx_ordinary" }, { value: "asic_reported" }], "asx_ordinary")).toBe("asic_reported");
  });
});

describe("the selection and the compare tray", () => {
  const rows = model().rows;
  const [first, second, third] = GOLDEN_IDS;

  it("reads ?sel= as a strategy, and falls back to the default", () => {
    expect(parseSelection(`strategy:${second}`, rows, "crowded-short-breakout")).toBe(second);
    expect(parseSelection("strategy:nope", rows, "crowded-short-breakout")).toBe("crowded-short-breakout");
    expect(parseSelection("stock:BHP", rows, first!)).toBe(first);
    expect(parseSelection(null, rows, null)).toBeNull();
  });

  it("keeps only known ids in ?ids=, unique and at most the limit", () => {
    expect(parseIds([second, "nope", second, first, third, ...GOLDEN_IDS].join(","), rows)).toEqual([
      second,
      first,
      third,
    ].slice(0, COMPARE_LIMIT));
    expect(parseIds(null, rows)).toEqual([]);
  });

  it("never holds more than three: a fourth tick is ignored", () => {
    let picked: string[] = [];
    for (const id of GOLDEN_IDS.slice(0, 4)) picked = toggleId(picked, id);
    expect(picked).toHaveLength(COMPARE_LIMIT);
    expect(picked).not.toContain(GOLDEN_IDS[3]);
    expect(toggleId(picked, GOLDEN_IDS[1]!)).toEqual([GOLDEN_IDS[0], GOLDEN_IDS[2]]);
  });

  it("links the comparison in the order picked, and offers the registry's strategies", () => {
    expect(compareHref([second!, first!])).toBe(`/strategies/compare?ids=${second},${first}`);
    expect(compareCandidates().map((c) => c.id)).toEqual(STRATEGY_SLUGS);
  });

  it("reads the window from ?window= and defaults to since May 2019", () => {
    expect(parseWindow("since_2023")).toBe("since_2023");
    expect(parseWindow("bogus")).toBe("since_2019_05");
  });
});

describe("dates and chart time", () => {
  it("prints a short day, and nothing for an empty or invalid day", () => {
    expect(shortDate("2026-11-03")).toBe("3 Nov 2026");
    expect(shortDate("")).toBe("");
    expect(shortDate("not-a-date")).toBe("");
  });

  it("reads a session date as epoch milliseconds at UTC midnight, and NaN for garbage", () => {
    expect(epochOf("2026-11-03")).toBe(Date.UTC(2026, 10, 3));
    expect(Number.isNaN(epochOf("garbage"))).toBe(true);
  });
});
