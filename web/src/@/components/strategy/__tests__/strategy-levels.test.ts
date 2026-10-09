import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FIT_STATUS_STRENGTH,
  LEVEL_COLORS,
  PRICE_ONLY_NOTE,
  defaultStrategyId,
  smaIndicator,
  strategyLevelSet,
} from "../strategy-levels";
import type {
  StockPriceFeatures,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";

const DAY = 86_400_000;

const row = (
  strategyId: string,
  status: StockStrategyFitRow["status"],
  score: number | null,
): StockStrategyFitRow => ({
  strategyId,
  strategyName: strategyId,
  status,
  score,
  rank: null,
  totalCount: null,
  rules: [],
  ruleColumns: [],
});

const pf: StockPriceFeatures = {
  asOf: "2026-10-07",
  close: 42.1,
  sma50: 40,
  sma150: 39,
  sma200: 38.5,
  sma200PriorMonth: 38.1,
  high52w: 45,
  low52w: 30,
  baseHigh: 43,
  baseLow: 39,
  baseDepthPct: 9.3,
  baseLengthDays: 22,
  breakoutRecent: true,
  breakoutDate: "2026-09-19",
  rs3mPct: 4.2,
  rs6mPct: null,
  volumeRatio50d: 1.8,
  sessionsAvailable: 260,
};

const labels = (items: Array<{ label: string }>) => items.map((i) => i.label);

describe("PRICE_ONLY_NOTE", () => {
  // The stock tabs e2e (web/e2e/stock-tabs.spec.ts) skips its levels test, with
  // a stated reason, only while the Strategy page shows exactly this note (the
  // API or this build predates PR 1's price features), so any other cause of a
  // missing level still fails. An e2e spec imports nothing from the app, so it
  // keeps its own copy; this pins the copy to the source. Change the note and
  // this fails until the spec follows.
  it("is the text the stock tabs e2e skips on", () => {
    const spec = readFileSync(
      path.resolve(__dirname, "../../../../../e2e/stock-tabs.spec.ts"),
      "utf8",
    );
    expect(spec).toContain(JSON.stringify(PRICE_ONLY_NOTE));
  });
});

describe("FIT_STATUS_STRENGTH", () => {
  it("ranks triggered above setup above watch above none", () => {
    const statuses = Object.keys(FIT_STATUS_STRENGTH) as Array<
      StockStrategyFitRow["status"]
    >;
    const strongestFirst = [...statuses].sort(
      (a, b) => FIT_STATUS_STRENGTH[b] - FIT_STATUS_STRENGTH[a],
    );
    expect(strongestFirst).toEqual(["triggered", "setup", "watch", "none"]);
  });
});

describe("defaultStrategyId", () => {
  it("prefers the strongest status, then the higher score, then order", () => {
    expect(
      defaultStrategyId([
        row("a", "watch", 90),
        row("b", "setup", 10),
        row("c", "triggered", 5),
      ]),
    ).toBe("c");
    expect(
      defaultStrategyId([row("a", "setup", 40), row("b", "setup", 70)]),
    ).toBe("b");
    expect(
      defaultStrategyId([row("a", "none", null), row("b", "none", null)]),
    ).toBe("a");
    expect(defaultStrategyId([])).toBeNull();
  });

  it("keeps the earlier of two equally strong, equally scored strategies", () => {
    expect(
      defaultStrategyId([row("a", "setup", 55), row("b", "setup", 55)]),
    ).toBe("a");
  });

  it("reads a score of zero as a score, above having none", () => {
    expect(
      defaultStrategyId([row("a", "watch", null), row("b", "watch", 0)]),
    ).toBe("b");
  });
});

describe("strategyLevelSet", () => {
  it("zanger: base band, pivot across the base, breakout marker, depth/volume caption", () => {
    const set = strategyLevelSet("zanger-breakout", pf, {});
    expect(set.bands).toHaveLength(1);
    expect(set.bands[0]).toMatchObject({ low: 39, high: 43, axis: "left" });
    expect(set.bands[0]!.from).toBeLessThan(set.bands[0]!.to);
    expect(set.levels.map((l) => l.label)).toEqual(["Pivot $43.00"]);
    expect(set.markers.map((m) => m.label)).toEqual(["Breakout 19 Sep"]);
    expect(set.caption).toEqual([
      "Base 9.3% deep over 22 sessions",
      "Volume 1.8× the 50-day average",
    ]);
    expect(set.showShortSeries).toBe(false);
  });

  it("minervini: the three averages, the 52-week low and last month's SMA 200 dashed", () => {
    const set = strategyLevelSet("minervini-trend-template", pf, {});
    expect(set.levels.map((l) => l.label)).toEqual([
      "SMA 50 $40.00",
      "SMA 150 $39.00",
      "SMA 200 $38.50",
      "SMA 200 a month ago $38.10",
      "52-week low $30.00",
    ]);
    expect(set.levels[3]!.dash).toBe("4,3");
    expect(set.smaPeriods).toEqual([50, 150, 200]);
    expect(set.bands).toEqual([]);
  });

  it("canslim: 52-week high plus the base; crowded-short: base plus the short series and the rule's words", () => {
    expect(
      strategyLevelSet("canslim", pf, {}).levels.map((l) => l.label),
    ).toEqual(["52-week high $45.00", "Pivot $43.00"]);
    const crowded = strategyLevelSet("crowded-short-breakout", pf, {
      shortRuleDetail: "Short interest 6.5% ≥ 5%",
    });
    expect(crowded.showShortSeries).toBe(true);
    expect(crowded.caption).toContain("Short interest 6.5% ≥ 5%");
  });

  it("skips any level whose input is unknown, and is price-only without features", () => {
    const set = strategyLevelSet(
      "minervini-trend-template",
      { ...pf, sma150: null, low52w: null },
      {},
    );
    expect(set.levels.map((l) => l.label)).toEqual([
      "SMA 50 $40.00",
      "SMA 200 $38.50",
      "SMA 200 a month ago $38.10",
    ]);
    const none = strategyLevelSet("zanger-breakout", null, {});
    expect(none).toEqual({
      levels: [],
      bands: [],
      markers: [],
      caption: [PRICE_ONLY_NOTE],
      showShortSeries: false,
      smaPeriods: [],
    });
  });

  describe("the base", () => {
    it("without a breakout, spans the base back from the as-of date by its length in sessions, and bounds the pivot to the same span", () => {
      const set = strategyLevelSet(
        "zanger-breakout",
        { ...pf, breakoutRecent: false, breakoutDate: null },
        {},
      );
      const band = set.bands[0]!;
      expect(band.to).toBe(Date.UTC(2026, 9, 7));
      // 22 sessions are 22 * 7/5 calendar days: a session is not a day.
      expect((band.to - band.from) / DAY).toBeCloseTo(22 * 1.4, 6);
      expect(band).toMatchObject({
        color: LEVEL_COLORS.base,
        label: "Base",
      });
      expect(set.levels[0]).toMatchObject({
        axis: "left",
        value: 43,
        color: LEVEL_COLORS.pivot,
        from: band.from,
        to: band.to,
      });
    });

    // After a recent breakout mv_price_features reports base_high / base_low /
    // base_length_days AS AT THE BREAKOUT SESSION (CLAUDE.md, "The base is
    // anchored"), so the base ends there. Ending it at the last close drew the
    // band to the right of the base it describes: base_length_days sessions
    // back from a later date than the one the length was counted at.
    describe("after a breakout", () => {
      const breakoutMs = Date.UTC(2026, 8, 19); // pf: breakout 19 Sep, as-of 7 Oct

      it("ends the base at the breakout session, not the last close, and counts its length back from there", () => {
        const set = strategyLevelSet("zanger-breakout", pf, {});
        const band = set.bands[0]!;
        expect(band.to).toBe(breakoutMs);
        // `from` is recomputed from the new end (22 sessions are 22 * 7/5 days),
        // not carried over from an as-of anchored span.
        expect(band.from).toBe(breakoutMs - 22 * 1.4 * DAY);
        expect(band.from).not.toBe(Date.UTC(2026, 9, 7) - 22 * 1.4 * DAY);
      });

      it("ends the ranged pivot line with the band, never beyond the breakout", () => {
        const set = strategyLevelSet("zanger-breakout", pf, {});
        const band = set.bands[0]!;
        const pivot = set.levels[0]!;
        expect(pivot).toMatchObject({ value: 43, from: band.from, to: band.to });
        expect(pivot.to).toBeLessThanOrEqual(breakoutMs);
        // The breakout marker still sits on the session the base ends at.
        expect(set.markers[0]!.t).toBe(band.to);
      });

      it.each(["canslim", "crowded-short-breakout"])(
        "does the same for %s, which draws the same base",
        (strategyId) => {
          const set = strategyLevelSet(strategyId, pf, {});
          const pivot = set.levels.find((l) => l.label.startsWith("Pivot"))!;
          expect(set.bands[0]!.to).toBe(breakoutMs);
          expect(pivot.to).toBe(breakoutMs);
          expect(pivot.from).toBe(set.bands[0]!.from);
        },
      );

      it.each(["not a date", "2026-02-31", ""])(
        "falls back to the as-of date when the breakout date %p is not a real day",
        (breakoutDate) => {
          const set = strategyLevelSet("zanger-breakout", { ...pf, breakoutDate }, {});
          expect(set.bands[0]!.to).toBe(Date.UTC(2026, 9, 7));
          expect(set.levels[0]).toMatchObject({ to: Date.UTC(2026, 9, 7) });
        },
      );
    });

    it.each<[string, Partial<StockPriceFeatures>]>([
      ["the base length", { baseLengthDays: null }],
      ["the base low", { baseLow: null }],
      ["the as-of date", { asOf: "" }],
    ])(
      "draws the pivot across the whole chart, and no band, when %s is unknown",
      (_what, unknown) => {
        const set = strategyLevelSet(
          "zanger-breakout",
          { ...pf, ...unknown },
          {},
        );
        expect(set.bands).toEqual([]);
        expect(labels(set.levels)).toEqual(["Pivot $43.00"]);
        expect(set.levels[0]).not.toHaveProperty("from");
        expect(set.levels[0]).not.toHaveProperty("to");
      },
    );

    it("draws neither pivot nor band without a base, but keeps the breakout and the volume line", () => {
      const set = strategyLevelSet(
        "zanger-breakout",
        {
          ...pf,
          baseHigh: null,
          baseLow: null,
          baseDepthPct: null,
          baseLengthDays: null,
        },
        {},
      );
      expect(set.levels).toEqual([]);
      expect(set.bands).toEqual([]);
      expect(labels(set.markers)).toEqual(["Breakout 19 Sep"]);
      expect(set.caption).toEqual(["Volume 1.8× the 50-day average"]);
    });

    it("leaves a caption line out when its figure is unknown", () => {
      expect(
        strategyLevelSet("zanger-breakout", { ...pf, volumeRatio50d: null }, {})
          .caption,
      ).toEqual(["Base 9.3% deep over 22 sessions"]);
      expect(
        strategyLevelSet("zanger-breakout", { ...pf, baseDepthPct: null }, {})
          .caption,
      ).toEqual(["Volume 1.8× the 50-day average"]);
    });
  });

  describe("the breakout marker", () => {
    it("sits on the breakout session, at UTC midnight", () => {
      const set = strategyLevelSet("zanger-breakout", pf, {});
      expect(set.markers).toEqual([
        {
          t: Date.UTC(2026, 8, 19),
          label: "Breakout 19 Sep",
          color: LEVEL_COLORS.breakout,
        },
      ]);
    });

    it("names every month by its fixed three-letter name, whatever the runtime's locale data says", () => {
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      const marked = months.map((_, i) => {
        const breakoutDate = `2026-${String(i + 1).padStart(2, "0")}-03`;
        return strategyLevelSet("zanger-breakout", { ...pf, breakoutDate }, {})
          .markers[0]?.label;
      });
      expect(marked).toEqual(months.map((m) => `Breakout 3 ${m}`));
    });

    it("draws no marker without a breakout date, or for a date that is not a real day", () => {
      for (const breakoutDate of [null, "", "not a date", "2026-02-31"]) {
        const set = strategyLevelSet(
          "zanger-breakout",
          { ...pf, breakoutDate },
          {},
        );
        expect(set.markers).toEqual([]);
      }
    });
  });

  describe("canslim", () => {
    it("quotes relative strength in percentage points ahead of the base lines", () => {
      const set = strategyLevelSet("canslim", pf, {});
      expect(set.caption).toEqual([
        "RS 3m +4.2pp",
        "Base 9.3% deep over 22 sessions",
        "Volume 1.8× the 50-day average",
      ]);
      expect(set.bands).toHaveLength(1);
      expect(set.markers).toHaveLength(1);
      expect(set.showShortSeries).toBe(false);
      expect(set.smaPeriods).toEqual([]);
    });

    it("signs both windows, with a true minus, and leaves an unmeasured one out", () => {
      const both = strategyLevelSet(
        "canslim",
        { ...pf, rs3mPct: -3.2, rs6mPct: 12 },
        {},
      );
      expect(both.caption.slice(0, 2)).toEqual([
        "RS 3m −3.2pp",
        "RS 6m +12.0pp",
      ]);
      const neither = strategyLevelSet(
        "canslim",
        { ...pf, rs3mPct: null, rs6mPct: null },
        {},
      );
      expect(neither.caption).toEqual([
        "Base 9.3% deep over 22 sessions",
        "Volume 1.8× the 50-day average",
      ]);
    });

    it("draws the levels in the strategy's own colours", () => {
      const set = strategyLevelSet("canslim", pf, {});
      expect(set.levels.map((l) => l.color)).toEqual([
        LEVEL_COLORS.range,
        LEVEL_COLORS.pivot,
      ]);
    });
  });

  describe("minervini", () => {
    it("colours each average by its own, and the dashed one like the 200-day", () => {
      const set = strategyLevelSet("minervini-trend-template", pf, {});
      expect(set.levels.map((l) => l.color)).toEqual([
        LEVEL_COLORS.sma50,
        LEVEL_COLORS.sma150,
        LEVEL_COLORS.sma200,
        LEVEL_COLORS.sma200,
        LEVEL_COLORS.range,
      ]);
      expect(set.levels.map((l) => l.dash)).toEqual([
        undefined,
        undefined,
        undefined,
        "4,3",
        undefined,
      ]);
      expect(set.markers).toEqual([]);
      expect(set.showShortSeries).toBe(false);
    });

    it("compares the close with the 52-week high, and says nothing when it cannot", () => {
      expect(
        strategyLevelSet("minervini-trend-template", pf, {}).caption,
      ).toEqual(["Close $42.10 vs 52-week high $45.00"]);
      expect(
        strategyLevelSet(
          "minervini-trend-template",
          { ...pf, high52w: null },
          {},
        ).caption,
      ).toEqual([]);
      expect(
        strategyLevelSet("minervini-trend-template", { ...pf, close: null }, {})
          .caption,
      ).toEqual([]);
    });
  });

  describe("crowded-short", () => {
    it("quotes the rule's evidence first, then the base lines, and draws the short series", () => {
      const set = strategyLevelSet("crowded-short-breakout", pf, {
        shortRuleDetail: "Short interest 6.5% ≥ 5%",
      });
      expect(set.caption).toEqual([
        "Short interest 6.5% ≥ 5%",
        "Base 9.3% deep over 22 sessions",
        "Volume 1.8× the 50-day average",
      ]);
      expect(labels(set.levels)).toEqual(["Pivot $43.00"]);
      expect(set.bands).toHaveLength(1);
      expect(set.showShortSeries).toBe(true);
      expect(set.smaPeriods).toEqual([]);
    });

    it("leaves a missing or blank piece of evidence out of the caption", () => {
      const base = [
        "Base 9.3% deep over 22 sessions",
        "Volume 1.8× the 50-day average",
      ];
      for (const opts of [
        {},
        { shortRuleDetail: "" },
        { shortRuleDetail: "  " },
      ]) {
        const set = strategyLevelSet("crowded-short-breakout", pf, opts);
        expect(set.caption).toEqual(base);
        expect(set.showShortSeries).toBe(true);
      }
    });
  });

  describe("the strategies with a single average", () => {
    it("quality-compounders: the 200-day level and line, nothing else", () => {
      const set = strategyLevelSet("quality-compounders", pf, {});
      expect(labels(set.levels)).toEqual(["SMA 200 $38.50"]);
      expect(set.smaPeriods).toEqual([200]);
      expect(set.caption).toEqual([]);
      expect(set.bands).toEqual([]);
      expect(set.markers).toEqual([]);
      expect(set.showShortSeries).toBe(false);
    });

    it("falls back to the 200-day average and the 52-week range for a strategy it has no set for", () => {
      for (const id of ["a-strategy-added-later", ""]) {
        const set = strategyLevelSet(id, pf, {});
        expect(labels(set.levels)).toEqual([
          "SMA 200 $38.50",
          "52-week high $45.00",
          "52-week low $30.00",
        ]);
        expect(set.smaPeriods).toEqual([200]);
        expect(set.showShortSeries).toBe(false);
      }
    });
  });
});

describe("smaIndicator", () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ t: i, v: i + 1 }));
  it("refuses a partial window and nulls the warmup", () => {
    expect(smaIndicator(pts, 11)).toBeNull();
    const sma = smaIndicator(pts, 3)!;
    expect(sma.slice(0, 2)).toEqual([null, null]);
    expect(sma[2]).toBeCloseTo(2);
    expect(sma[9]).toBeCloseTo(9);
  });

  it("stays aligned to the points it was given", () => {
    expect(smaIndicator(pts, 3)).toHaveLength(pts.length);
  });

  it("accepts a window exactly as long as the points, and yields one value, the last", () => {
    const sma = smaIndicator(pts, 10)!;
    expect(sma.slice(0, 9)).toEqual(Array(9).fill(null));
    expect(sma[9]).toBeCloseTo(5.5);
  });

  it("has no line for no points or a period that is not positive", () => {
    expect(smaIndicator([], 5)).toBeNull();
    expect(smaIndicator(pts, 0)).toBeNull();
    expect(smaIndicator(pts, -3)).toBeNull();
  });
});
