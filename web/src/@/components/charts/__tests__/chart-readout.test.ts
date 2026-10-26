import {
  READOUT_LINE_H,
  READOUT_PAD,
  READOUT_ROW_H_ONE,
  buildLatestReadout,
  buildMeasureReadout,
  buildPointReadout,
  formatReadoutDate,
  formatReadoutShortDate,
  readoutDayKey,
  readoutStripHeight,
  resolveReadoutMode,
  seriesDelta,
  volumeReading,
  widestValueChars,
  type ReadoutFormat,
} from "../chart-readout";
import type { ChartPoint, ChartSeriesSpec } from "../types";

const DAY = 86_400_000;
/** U+2212, DESIGN.md's minus. Written as an escape: it looks like a hyphen. */
const MINUS = "\u2212";
/** 00:00 UTC on 2026-10-<d>: that morning on the same calendar day in Sydney. */
const oct = (d: number) => Date.UTC(2026, 9, d);

const pts = (...rows: [day: number, v: number][]): ChartPoint[] =>
  rows.map(([d, v]) => ({ t: oct(d), v }));

const priceSeries = (points: ChartPoint[]): ChartSeriesSpec => ({
  id: "BHP:price",
  label: "Price",
  color: "#111111",
  axis: "left",
  kind: "area",
  points,
});

// Short interest is already a percentage, so it measures in points.
const shortSeries = (points: ChartPoint[]): ChartSeriesSpec => ({
  id: "BHP:short",
  label: "Short %",
  color: "#cc3333",
  axis: "right",
  kind: "line",
  points,
  measureMode: "absolute",
  measureUnit: "pp",
});

const format: ReadoutFormat = (s, v) =>
  s.axis === "right" ? `${v.toFixed(2)}%` : `$${v.toFixed(2)}`;

describe("seriesDelta", () => {
  const rel = priceSeries([]);
  const abs = shortSeries([]);
  const p = (v: number): ChartPoint => ({ t: oct(1), v });

  it("relative: percent change to one decimal, signed, and colourable", () => {
    expect(seriesDelta(rel, p(40), p(41.24))).toEqual({
      value: 3.1,
      text: "+3.1%",
      tone: "up",
      colored: true,
    });
    expect(seriesDelta(rel, p(40), p(38.76))).toEqual({
      value: -3.1,
      text: `${MINUS}3.1%`,
      tone: "down",
      colored: true,
    });
  });

  it("absolute: the raw difference to two decimals with its unit, never colourable", () => {
    expect(seriesDelta(abs, p(3), p(3.21))).toEqual({
      value: 0.21,
      text: "+0.21 pp",
      tone: "up",
      colored: false,
    });
    expect(seriesDelta(abs, p(3.21), p(3))).toEqual({
      value: -0.21,
      text: `${MINUS}0.21 pp`,
      tone: "down",
      colored: false,
    });
  });

  it("absolute: no unit means no trailing space", () => {
    expect(
      seriesDelta({ ...abs, measureUnit: undefined }, p(3), p(3.21)).text,
    ).toBe("+0.21");
    expect(seriesDelta({ ...abs, measureUnit: "" }, p(3), p(3.21)).text).toBe(
      "+0.21",
    );
  });

  it("signs a fall with a true minus (U+2212), never the ASCII hyphen, and a rise with a plus", () => {
    const fall = [
      seriesDelta(rel, p(40), p(38.76)).text,
      seriesDelta(abs, p(3.21), p(3)).text,
    ];
    for (const text of fall) {
      expect(text.codePointAt(0)).toBe(0x2212);
      expect(text).not.toContain("-");
    }
    expect(seriesDelta(rel, p(40), p(41.24)).text.codePointAt(0)).toBe(0x2b);
    // A flat change has no sign at all.
    expect(seriesDelta(rel, p(40), p(40)).text).toBe("0.0%");
  });

  it("rounds before taking the sign, so a change too small to show is flat", () => {
    // +0.025% is "0.0" at one decimal; +0.004 pp is "0.00" at two.
    expect(seriesDelta(rel, p(40), p(40.01))).toEqual({
      value: 0,
      text: "0.0%",
      tone: "flat",
      colored: true,
    });
    expect(seriesDelta(abs, p(3), p(3.004))).toEqual({
      value: 0,
      text: "0.00 pp",
      tone: "flat",
      colored: false,
    });
  });

  it("never produces -0, in the number or in the text", () => {
    // -0.025% is "-0.0" at one decimal, -0.004 pp is "-0.00" at two.
    const relDown = seriesDelta(rel, p(40), p(39.99));
    const absDown = seriesDelta(abs, p(3), p(2.996));
    expect(Object.is(relDown.value, 0)).toBe(true);
    expect(Object.is(absDown.value, 0)).toBe(true);
    expect(relDown.text).toBe("0.0%");
    expect(absDown.text).toBe("0.00 pp");
    expect(relDown.tone).toBe("flat");
    expect(absDown.tone).toBe("flat");
  });

  it("a zero base reads 0 instead of dividing by it", () => {
    expect(seriesDelta(rel, p(0), p(5))).toEqual({
      value: 0,
      text: "0.0%",
      tone: "flat",
      colored: true,
    });
  });

  it("a zero base is an ordinary difference when absolute", () => {
    expect(seriesDelta(abs, p(0), p(0.5)).text).toBe("+0.50 pp");
  });
});

describe("readout dates", () => {
  it("formats en-AU, in Sydney", () => {
    expect(formatReadoutDate(oct(9))).toBe("9 Oct 2026");
    expect(formatReadoutShortDate(oct(9))).toBe("9 Oct");
  });

  it("names the Sydney day, not the UTC day", () => {
    // 07:00 on the 9th in Sydney (AEDT, UTC+11), still the 8th in UTC.
    const t = Date.UTC(2026, 9, 8, 20);
    expect(formatReadoutDate(t)).toBe("9 Oct 2026");
    expect(formatReadoutShortDate(t)).toBe("9 Oct");
    expect(readoutDayKey(t)).toBe("2026-10-09");
  });

  it("changes day at Sydney midnight, an hour later in winter", () => {
    // Summer (AEDT, UTC+11): 23:59 on the 8th, then midnight.
    expect(readoutDayKey(Date.UTC(2026, 9, 8, 12, 59))).toBe("2026-10-08");
    expect(readoutDayKey(Date.UTC(2026, 9, 8, 13, 0))).toBe("2026-10-09");
    // Winter (AEST, UTC+10).
    expect(readoutDayKey(Date.UTC(2026, 6, 8, 13, 59))).toBe("2026-07-08");
    expect(readoutDayKey(Date.UTC(2026, 6, 8, 14, 0))).toBe("2026-07-09");
  });

  it("keeps a UTC-midnight timestamp on its own calendar day", () => {
    expect(readoutDayKey(oct(9))).toBe("2026-10-09");
    expect(readoutDayKey(Date.UTC(2026, 6, 9))).toBe("2026-07-09");
  });
});

describe("buildLatestReadout", () => {
  // Price runs to Fri 9 Oct. Short interest is published T+4: it ends 5 Oct.
  const price = priceSeries([
    { t: oct(5), v: 39, open: 38.5, high: 39.5, low: 38, close: 39 },
    { t: oct(7), v: 40, open: 39, high: 40.5, low: 38.9, close: 40 },
    { t: oct(9), v: 42, open: 41, high: 42.5, low: 40.8, close: 42 },
  ]);
  const short = shortSeries(pts([1, 3.0], [3, 3.1], [5, 3.21]));
  const latest = (
    over: Partial<Parameters<typeof buildLatestReadout>[0]> = {},
  ) =>
    buildLatestReadout({
      series: [price, short],
      zoomed: false,
      viewMode: "absolute",
      format,
      ...over,
    });

  it("heads an unzoomed reading with 'Latest' and the newest date", () => {
    const m = latest();
    expect(m.state).toBe("latest");
    expect(m.headline).toBe("Latest · 9 Oct 2026");
  });

  it("heads a zoomed reading with the newest visible date alone", () => {
    expect(latest({ zoomed: true }).headline).toBe("9 Oct 2026");
  });

  it("takes the headline date from whichever series ends last, in any order", () => {
    expect(latest({ series: [short, price] }).headline).toBe(
      "Latest · 9 Oct 2026",
    );
  });

  it("shows each series' last value, formatted by the caller, in series order", () => {
    const m = latest();
    expect(m.entries.map((e) => [e.id, e.label, e.color, e.value])).toEqual([
      ["BHP:price", "Price", "#111111", "$42.00"],
      ["BHP:short", "Short %", "#cc3333", "3.21%"],
    ]);
    expect(latest({ series: [short, price] }).entries.map((e) => e.id)).toEqual(
      ["BHP:short", "BHP:price"],
    );
  });

  it("measures the change over the visible range: relative for price, points for short", () => {
    const [p, s] = latest().entries;
    expect(p!.change).toEqual({
      value: 7.7,
      text: "+7.7%",
      tone: "up",
      colored: true,
    });
    expect(s!.change).toEqual({
      value: 0.21,
      text: "+0.21 pp",
      tone: "up",
      colored: false,
    });
  });

  it("dates a short series that ends on another day, and not the price", () => {
    const [p, s] = latest().entries;
    expect(s!.dateNote).toBe("5 Oct");
    expect(p!.dateNote).toBeNull();
  });

  it("compares Sydney days, not timestamps or UTC days", () => {
    const sameInstantDay = latest({
      series: [
        priceSeries(pts([8, 40], [9, 42])),
        shortSeries([
          { t: oct(8), v: 3 },
          { t: oct(9) + 5 * 3_600_000, v: 3.2 }, // later that day, same day
        ]),
      ],
    });
    expect(sameInstantDay.entries.map((e) => e.dateNote)).toEqual([null, null]);

    // One minute apart, but either side of Sydney midnight on 9 Oct.
    const acrossMidnight = latest({
      series: [
        priceSeries([
          { t: Date.UTC(2026, 9, 7, 13, 0), v: 40 },
          { t: Date.UTC(2026, 9, 8, 13, 0), v: 42 },
        ]),
        shortSeries([
          { t: Date.UTC(2026, 9, 7, 12, 59), v: 3 },
          { t: Date.UTC(2026, 9, 8, 12, 59), v: 3.2 },
        ]),
      ],
    });
    expect(acrossMidnight.entries.map((e) => e.dateNote)).toEqual([
      null,
      "8 Oct",
    ]);

    // Same Sydney day (the 9th) though the UTC days differ (8th and 9th).
    const sameSydneyDay = latest({
      series: [
        priceSeries([
          { t: Date.UTC(2026, 9, 8, 14), v: 40 },
          { t: Date.UTC(2026, 9, 8, 20), v: 42 },
        ]),
        shortSeries([
          { t: Date.UTC(2026, 9, 8, 14), v: 3 },
          { t: Date.UTC(2026, 9, 9, 10), v: 3.2 },
        ]),
      ],
    });
    expect(sameSydneyDay.entries.map((e) => e.dateNote)).toEqual([null, null]);
  });

  it("keeps a series with no points as a row of nulls", () => {
    const m = latest({ series: [price, shortSeries([])] });
    expect(m.headline).toBe("Latest · 9 Oct 2026");
    expect(m.entries).toHaveLength(2);
    expect(m.entries[1]).toEqual({
      id: "BHP:short",
      label: "Short %",
      color: "#cc3333",
      value: null,
      change: null,
      dateNote: null,
      ohlc: null,
    });
    // ...and it does not disturb the series that has points.
    expect(m.entries[0]!.value).toBe("$42.00");
  });

  it("names no date and keeps every row when no series has a point", () => {
    const m = latest({ series: [priceSeries([]), shortSeries([])] });
    expect(m.headline).toBe("");
    expect(
      latest({ series: [priceSeries([]), shortSeries([])], zoomed: true })
        .headline,
    ).toBe("");
    expect(m.entries.map((e) => [e.id, e.value, e.change])).toEqual([
      ["BHP:price", null, null],
      ["BHP:short", null, null],
    ]);
    expect(latest({ series: [] }).entries).toEqual([]);
  });

  it("shows no change in the normalised view, only the values", () => {
    const m = latest({ viewMode: "normalized" });
    expect(m.entries.map((e) => e.change)).toEqual([null, null]);
    expect(m.entries.map((e) => e.value)).toEqual(["$42.00", "3.21%"]);
  });

  it("shows no change for a series with a single point", () => {
    const m = latest({ series: [priceSeries(pts([9, 42])), short] });
    expect(m.entries[0]!.value).toBe("$42.00");
    expect(m.entries[0]!.change).toBeNull();
    expect(m.entries[1]!.change).not.toBeNull();
  });

  it("carries open, high, low and close only when the last point has all four", () => {
    expect(latest().entries[0]!.ohlc).toEqual({
      open: "41.00",
      high: "42.50",
      low: "40.80",
      close: "42.00",
    });
    // The short series has no OHLC at all.
    expect(latest().entries[1]!.ohlc).toBeNull();

    // An earlier point with all four does not stand in for a last point without.
    const missingLow = priceSeries([
      { t: oct(7), v: 40, open: 39, high: 40.5, low: 38.9, close: 40 },
      { t: oct(9), v: 42, open: 41, high: 42.5, close: 42 },
    ]);
    expect(latest({ series: [missingLow] }).entries[0]!.ohlc).toBeNull();

    // A zero is a value, not a missing one.
    const zeroOpen = priceSeries([
      { t: oct(9), v: 1, open: 0, high: 1, low: 0, close: 1 },
    ]);
    expect(latest({ series: [zeroOpen] }).entries[0]!.ohlc).toEqual({
      open: "0.00",
      high: "1.00",
      low: "0.00",
      close: "1.00",
    });
  });
});

describe("buildPointReadout", () => {
  const price = priceSeries([
    { t: oct(8), v: 41, open: 40, high: 41.5, low: 39.9, close: 41 },
    { t: oct(9), v: 42, open: 41, high: 42.5, low: 40.8, close: 42 },
  ]);
  const short = shortSeries(pts([1, 3.0], [5, 3.21]));
  const volume: ChartSeriesSpec = {
    ...priceSeries([]),
    id: "BHP:volume",
    label: "Volume",
    color: "#888888",
  };
  const entries = [
    { series: price, point: price.points[1]! },
    { series: short, point: short.points[1]! },
  ];

  it("heads the reading with the first entry's date", () => {
    const m = buildPointReadout({
      series: [price, short],
      entries,
      pinned: false,
      format,
    });
    expect(m.headline).toBe("9 Oct 2026");
  });

  it("is a hover reading unless pinned", () => {
    const args = { series: [price, short], entries, format };
    expect(buildPointReadout({ ...args, pinned: false }).state).toBe("hover");
    expect(buildPointReadout({ ...args, pinned: true }).state).toBe("pinned");
  });

  it("gives each series its point's value and no change", () => {
    const m = buildPointReadout({
      series: [price, short],
      entries,
      pinned: false,
      format,
    });
    expect(m.entries.map((e) => [e.id, e.value, e.change])).toEqual([
      ["BHP:price", "$42.00", null],
      ["BHP:short", "3.21%", null],
    ]);
  });

  it("dates a point that falls on another day than the first entry's", () => {
    const m = buildPointReadout({
      series: [price, short],
      entries,
      pinned: false,
      format,
    });
    expect(m.entries.map((e) => e.dateNote)).toEqual([null, "5 Oct"]);
  });

  it("carries OHLC from the point when it has all four", () => {
    const m = buildPointReadout({
      series: [price, short],
      entries,
      pinned: false,
      format,
    });
    expect(m.entries[0]!.ohlc).toEqual({
      open: "41.00",
      high: "42.50",
      low: "40.80",
      close: "42.00",
    });
    expect(m.entries[1]!.ohlc).toBeNull();
  });

  it("follows the series order, matching entries by id", () => {
    const m = buildPointReadout({
      series: [short, price],
      entries, // price first, as the pointer found them
      pinned: false,
      format,
    });
    expect(m.entries.map((e) => e.id)).toEqual(["BHP:short", "BHP:price"]);
    // The headline is still the first ENTRY's date, not the first series'.
    expect(m.headline).toBe("9 Oct 2026");
    expect(m.entries.map((e) => e.dateNote)).toEqual(["5 Oct", null]);
  });

  it("keeps a row of nulls for a series without an entry", () => {
    const m = buildPointReadout({
      series: [price, volume, short],
      entries,
      pinned: false,
      format,
    });
    expect(m.entries.map((e) => e.id)).toEqual([
      "BHP:price",
      "BHP:volume",
      "BHP:short",
    ]);
    expect(m.entries[1]).toEqual({
      id: "BHP:volume",
      label: "Volume",
      color: "#888888",
      value: null,
      change: null,
      dateNote: null,
      ohlc: null,
    });
  });

  it("names no date when there is no entry at all", () => {
    const m = buildPointReadout({
      series: [price, short],
      entries: [],
      pinned: true,
      format,
    });
    expect(m.headline).toBe("");
    expect(m.state).toBe("pinned");
    expect(m.entries.map((e) => e.value)).toEqual([null, null]);
  });
});

describe("buildMeasureReadout", () => {
  const price = priceSeries(pts([5, 39], [6, 40], [7, 40.5], [8, 41], [9, 42]));
  const short = shortSeries(
    pts([5, 3.0], [6, 3.0], [7, 3.1], [8, 3.15], [9, 3.21]),
  );

  it("heads the reading with the two dates and an arrow", () => {
    const m = buildMeasureReadout({
      series: [price, short],
      ta: oct(6),
      tb: oct(9),
    });
    expect(m.state).toBe("measure");
    expect(m.headline).toBe("6 Oct 2026 → 9 Oct 2026");
  });

  describe("the dates in the headline", () => {
    it("name the sessions compared, not the instants the pointer was at", () => {
      // 0.49 of a day short of the 6th and of the 9th: 12:14 UTC, which is 23:14
      // on the 5th and on the 8th in Sydney, and 0.49 from the points on the 6th
      // and the 9th. They are what the pointer is nearest, and what the changes
      // below are between.
      const m = buildMeasureReadout({
        series: [price, short],
        ta: oct(6) - 0.49 * DAY,
        tb: oct(9) - 0.49 * DAY,
      });
      expect(m.headline).toBe("6 Oct 2026 \u2192 9 Oct 2026");
      expect(m.entries.map((e) => e.change?.text)).toEqual(["+5.0%", "+0.21 pp"]);
    });

    it("are those of the first series, whatever the others are nearest", () => {
      // The short series is published on some days only: its nearest point to
      // the 6th is the 5th, but the headline names the price's sessions.
      const sparse = shortSeries(pts([5, 3.0], [8, 3.15]));
      const m = buildMeasureReadout({
        series: [price, sparse],
        ta: oct(6),
        tb: oct(9),
      });
      expect(m.headline).toBe("6 Oct 2026 \u2192 9 Oct 2026");
      // Led by the sparse series instead, it is the sparse series' sessions.
      const led = buildMeasureReadout({
        series: [sparse, price],
        ta: oct(6),
        tb: oct(9),
      });
      expect(led.headline).toBe("5 Oct 2026 \u2192 8 Oct 2026");
    });

    it("fall back to the pointer's times when the first series has no point", () => {
      const m = buildMeasureReadout({
        series: [priceSeries([]), short],
        ta: oct(6),
        tb: oct(9),
      });
      expect(m.headline).toBe("6 Oct 2026 \u2192 9 Oct 2026");
      const none = buildMeasureReadout({ series: [], ta: oct(6), tb: oct(9) });
      expect(none.headline).toBe("6 Oct 2026 \u2192 9 Oct 2026");
    });
  });

  it("reports each series' change between its points nearest each end", () => {
    const m = buildMeasureReadout({
      series: [price, short],
      ta: oct(6),
      tb: oct(9),
    });
    expect(
      m.entries.map((e) => [e.id, e.change?.text, e.change?.colored]),
    ).toEqual([
      ["BHP:price", "+5.0%", true],
      ["BHP:short", "+0.21 pp", false],
    ]);
    // Between points, and past the end of the data, it snaps to the nearest.
    const snapped = buildMeasureReadout({
      series: [price, short],
      ta: oct(6) + 0.4 * DAY,
      tb: oct(12),
    });
    expect(snapped.entries.map((e) => e.change?.text)).toEqual([
      "+5.0%",
      "+0.21 pp",
    ]);
  });

  it("names a change, never a value", () => {
    const m = buildMeasureReadout({
      series: [price, short],
      ta: oct(6),
      tb: oct(9),
    });
    expect(m.entries.every((e) => e.value === null)).toBe(true);
    expect(m.entries.every((e) => e.dateNote === null && e.ohlc === null)).toBe(
      true,
    );
  });

  it("reads a fall as down", () => {
    const m = buildMeasureReadout({
      series: [price, short],
      ta: oct(9),
      tb: oct(6),
    });
    expect(m.entries[0]!.change).toMatchObject({
      text: `${MINUS}4.8%`,
      tone: "down",
    });
    expect(m.entries[1]!.change).toMatchObject({
      text: `${MINUS}0.21 pp`,
      tone: "down",
    });
  });

  it("keeps a row without a change for a series with no points", () => {
    const m = buildMeasureReadout({
      series: [price, shortSeries([])],
      ta: oct(6),
      tb: oct(9),
    });
    expect(m.entries).toHaveLength(2);
    expect(m.entries[1]).toEqual({
      id: "BHP:short",
      label: "Short %",
      color: "#cc3333",
      value: null,
      change: null,
      dateNote: null,
      ohlc: null,
    });
  });
});

describe("readoutStripHeight", () => {
  it("is one 28px row from 640px wide, however many series it shows", () => {
    for (const n of [0, 1, 2, 5]) {
      expect(readoutStripHeight(640, n)).toBe(READOUT_ROW_H_ONE);
      expect(readoutStripHeight(1200, n)).toBe(28);
    }
  });

  it("is 44px for one series and 62px for two under 640px wide", () => {
    expect(readoutStripHeight(639, 1)).toBe(44);
    expect(readoutStripHeight(639, 2)).toBe(62);
    expect(readoutStripHeight(360, 1)).toBe(44);
    expect(readoutStripHeight(360, 2)).toBe(62);
  });

  it("is a headline line and a line for each series, plus 8px of padding, under 640px", () => {
    // The headline alone, then 18px for each series.
    expect(readoutStripHeight(639, 0)).toBe(READOUT_PAD + READOUT_LINE_H);
    expect(readoutStripHeight(639, 3)).toBe(READOUT_PAD + READOUT_LINE_H * 4);
    expect([READOUT_PAD, READOUT_LINE_H]).toEqual([8, 18]);
    for (const n of [0, 1, 2, 3]) {
      expect(readoutStripHeight(500, n + 1) - readoutStripHeight(500, n)).toBe(18);
    }
  });
});

describe("widestValueChars", () => {
  const key = priceSeries([]).id;

  it("is the wider of a series' lowest and highest value, as its axis formats them", () => {
    // "$99.50" is 6 characters and "$104.25" is 7: the highest value sets it...
    const rising = priceSeries(pts([1, 99.5], [2, 101], [3, 104.25], [4, 100]));
    expect(widestValueChars([rising], format)).toEqual({ [key]: 7 });
    // ...and when the longer one is at the other end, the lowest does: "$-100.00" is 8.
    const dipping = priceSeries(pts([1, -100], [2, 3], [3, 40]));
    expect(widestValueChars([dipping], format)).toEqual({ [key]: 8 });
  });

  it("does not depend on where in the series the widest value is", () => {
    const early = priceSeries(pts([1, 120], [2, 99], [3, 98]));
    const late = priceSeries(pts([1, 98], [2, 99], [3, 120]));
    expect(widestValueChars([early], format)).toEqual(widestValueChars([late], format));
  });

  it("counts the minus sign of a negative value", () => {
    // "$-5.00" is 6 characters; "$3.00" is 5.
    expect(widestValueChars([priceSeries(pts([1, -5], [2, 3]))], format)).toEqual({ [key]: 6 });
  });

  it("measures each series by its own format", () => {
    const price = priceSeries(pts([1, 43.21], [2, 40])); // "$43.21": 6
    const short = shortSeries(pts([1, 3.2], [2, 2.9])); // "3.20%": 5
    expect(widestValueChars([price, short], format)).toEqual({
      "BHP:price": 6,
      "BHP:short": 5,
    });
  });

  it("leaves out a series with no finite value, and skips the ones that are not among those that are", () => {
    const nothing = priceSeries([]);
    const unusable = shortSeries([
      { t: oct(1), v: NaN },
      { t: oct(2), v: Infinity },
    ]);
    expect(widestValueChars([nothing, unusable], format)).toEqual({});
    const mixed = priceSeries([
      { t: oct(1), v: 5 },
      { t: oct(2), v: NaN },
      { t: oct(3), v: 12 },
    ]);
    expect(widestValueChars([mixed], format)).toEqual({ [key]: 6 }); // "$12.00"
  });

  it("formats the two ends and nothing between them, however many points there are", () => {
    const many = priceSeries(
      Array.from({ length: 2000 }, (_, i): ChartPoint => ({ t: oct(1) + i * DAY, v: 10 + (i % 90) })),
    );
    const spy = jest.fn(format);
    widestValueChars([many], spy);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("resolveReadoutMode", () => {
  it("is the tooltip whenever the tooltip was asked for", () => {
    expect(
      resolveReadoutMode({
        requested: "tooltip",
        width: 1200,
        height: 800,
        seriesCount: 2,
        reservedH: 32,
      }),
    ).toBe("tooltip");
  });

  it("falls back to the tooltip when the plot left would be under 160px", () => {
    // 200 - 28 (strip) - 40 = 132.
    expect(
      resolveReadoutMode({
        requested: "strip",
        width: 1000,
        height: 200,
        seriesCount: 2,
        reservedH: 40,
      }),
    ).toBe("tooltip");
  });

  it("is the strip when the plot keeps its room", () => {
    // 360 - 28 - 32 = 300; on a phone 360 - 44 - 32 = 284 for one series, and
    // 360 - 62 - 32 = 266 for two.
    expect(
      resolveReadoutMode({
        requested: "strip",
        width: 1000,
        height: 360,
        seriesCount: 2,
        reservedH: 32,
      }),
    ).toBe("strip");
    for (const seriesCount of [1, 2]) {
      expect(
        resolveReadoutMode({
          requested: "strip",
          width: 360,
          height: 360,
          seriesCount,
          reservedH: 32,
        }),
      ).toBe("strip");
    }
  });

  it("keeps the strip at exactly 160px of plot and drops it one pixel short", () => {
    const wide = {
      requested: "strip",
      width: 1000,
      seriesCount: 2,
      reservedH: 32,
    } as const;
    expect(resolveReadoutMode({ ...wide, height: 220 })).toBe("strip"); // 160
    expect(resolveReadoutMode({ ...wide, height: 219 })).toBe("tooltip"); // 159
  });

  it("charges a narrow chart the taller strip", () => {
    const base = {
      requested: "strip",
      height: 220,
      seriesCount: 1,
      reservedH: 32,
    } as const;
    expect(resolveReadoutMode({ ...base, width: 640 })).toBe("strip"); // 160
    expect(resolveReadoutMode({ ...base, width: 639 })).toBe("tooltip"); // 144
  });

  it("charges a narrow chart a row for each series it shows", () => {
    const phone = {
      requested: "strip",
      width: 360,
      reservedH: 32,
    } as const;
    // One series: 44px strip. 236 - 44 - 32 = 160.
    expect(resolveReadoutMode({ ...phone, height: 236, seriesCount: 1 })).toBe("strip");
    // Two: 62px. The same chart is 18px short, and needs 254.
    expect(resolveReadoutMode({ ...phone, height: 236, seriesCount: 2 })).toBe("tooltip"); // 142
    expect(resolveReadoutMode({ ...phone, height: 254, seriesCount: 2 })).toBe("strip"); // 160
    expect(resolveReadoutMode({ ...phone, height: 253, seriesCount: 2 })).toBe("tooltip"); // 159
  });

  it("does not charge a wide chart for its series: it is one row whatever the count", () => {
    const wide = {
      requested: "strip",
      width: 640,
      height: 220,
      reservedH: 32,
    } as const;
    for (const seriesCount of [1, 2, 6]) {
      expect(resolveReadoutMode({ ...wide, seriesCount })).toBe("strip"); // 160
    }
  });
});

describe("the session's volume", () => {
  // Price and its volume come from the same rows: one per session, Mon to Fri.
  const price = priceSeries(pts([5, 39], [6, 40], [9, 42]));
  const short = shortSeries(pts([1, 3.0], [5, 3.21]));
  const volume = pts([5, 812_400], [6, 1_240_000], [9, 5_074_000_000]);

  describe("volumeReading", () => {
    it("is the session nearest the time, compact", () => {
      expect(volumeReading(volume, oct(6), readoutDayKey(oct(6)))).toEqual({
        value: "1.2M",
        dateNote: null,
      });
      expect(volumeReading(volume, oct(9), readoutDayKey(oct(9)))?.value).toBe("5.07B");
      expect(volumeReading(volume, oct(5), readoutDayKey(oct(5)))?.value).toBe("812.4K");
    });

    it("dates a session on another day than the headline", () => {
      expect(volumeReading(volume, oct(9), readoutDayKey(oct(10)))?.dateNote).toBe(
        formatReadoutShortDate(oct(9)),
      );
    });

    it("is absent, not n/a, when the chart draws no volume", () => {
      expect(volumeReading(undefined, oct(5), "")).toBeNull();
      expect(volumeReading([], oct(5), "")).toBeNull();
    });

    it("is n/a when there is volume but no reading to place it", () => {
      expect(volumeReading(volume, null, "")).toEqual({ value: null, dateNote: null });
    });
  });

  it("at rest is the newest session's on screen", () => {
    const m = buildLatestReadout({
      series: [price, short],
      zoomed: false,
      viewMode: "absolute",
      format,
      volume,
    });
    expect(m.volume).toEqual({ value: "5.07B", dateNote: null });
  });

  it("at rest is dated when the volume ends before the headline", () => {
    const m = buildLatestReadout({
      series: [price, short],
      zoomed: false,
      viewMode: "absolute",
      format,
      volume: volume.slice(0, 2),
    });
    expect(m.volume?.dateNote).toBe(formatReadoutShortDate(oct(6)));
  });

  it("under a pointer or a pin is the session of the first entry", () => {
    const m = buildPointReadout({
      series: [price, short],
      entries: [
        { series: price, point: price.points[1]! },
        { series: short, point: short.points[1]! },
      ],
      pinned: true,
      format,
      volume,
    });
    expect(m.volume).toEqual({ value: "1.2M", dateNote: null });
  });

  it("is left out when the chart draws none, and in a measure", () => {
    expect(
      buildLatestReadout({ series: [price], zoomed: false, viewMode: "absolute", format })
        .volume,
    ).toBeNull();
    expect(buildMeasureReadout({ series: [price], ta: oct(5), tb: oct(9) }).volume).toBe(
      undefined,
    );
  });
});
