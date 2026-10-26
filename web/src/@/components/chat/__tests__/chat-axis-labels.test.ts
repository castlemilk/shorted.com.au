import fs from "fs";
import path from "path";
import { scaleTime } from "@visx/scale";
import { timeTickValues } from "~/@/components/charts/chart-primitives";
import { valueAxisTicks } from "~/@/components/charts/use-chart-scales";
import type { ChartSeriesSpec } from "~/@/components/charts/types";
import {
  axisFormatter,
  latestFormatter,
  seriesSubtitle,
  tickDecimals,
  timeTickLabel,
} from "../chat-tool-format";

/** A seeded generator, so a failing range can be replayed. mulberry32. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seriesOver(lo: number, hi: number): ChartSeriesSpec[] {
  return [
    {
      id: "s",
      label: "s",
      color: "#000",
      axis: "left",
      kind: "line",
      points: [
        { t: 0, v: lo },
        { t: 1, v: hi },
      ],
    },
  ];
}

describe("tick decimals", () => {
  it("gives a step of two ten-millionths the seven places that print it", () => {
    // A tiny, near-flat series: a share of the register that moves in the 7th decimal.
    // The old absolute tolerance called this a whole step, and printed "0%" five times.
    expect(tickDecimals([0.0090994, 0.0090996, 0.0090998, 0.00910])).toBe(7);
  });

  it("gives a step too fine for the grid the places its own size needs", () => {
    expect(tickDecimals([0, 2.5e-14, 5e-14])).toBe(15);
  });

  it("ignores the same tick twice, which is float noise rather than a step", () => {
    expect(tickDecimals([15.92, 15.92 + 1e-15, 15.94])).toBe(2);
  });
});

describe("axis labels on generated ranges", () => {
  it("prints every tick of every generated axis apart, from a near-zero range to a wide one", () => {
    const random = generator(20261024);
    const units = ["percent", "aud", "usd_per_barrel", "sgd_per_usd", undefined] as const;
    for (let i = 0; i < 2000; i++) {
      const magnitude = 10 ** Math.floor(random() * 15 - 8);
      const centre = (random() < 0.5 ? -1 : 1) * magnitude * (1 + random() * 9);
      // The range spans from a half to a millionth of the value, the narrow ones being
      // the readings that round to one decimal.
      const spread = Math.abs(centre) * 10 ** -(random() * 6 + 0.5);
      const lo = centre - spread / 2;
      const hi = centre + spread / 2;
      const series = seriesOver(lo, hi);
      const ticks = valueAxisTicks({ series, side: "left", numTicks: 4 });
      const unit = units[i % units.length];
      const format = axisFormatter(unit)(ticks);
      const labels = ticks.map(format);
      // A failing range is named in the error, so it can be replayed.
      if (new Set(labels).size !== labels.length) {
        throw new Error(`adjacent ticks share a label: ${JSON.stringify({ lo, hi, labels })}`);
      }
    }
  });

  it("prints a narrow percentage range as distinct hundredths", () => {
    const ticks = valueAxisTicks({
      series: seriesOver(15.92, 15.94),
      side: "left",
      numTicks: 4,
    });
    const labels = ticks.map(axisFormatter("percent")(ticks));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.endsWith("%"))).toBe(true);
  });
});

describe("time axis labels", () => {
  const at = (year: number, month: number, day: number) => new Date(year, month, day);

  it("writes the year on the first tick and on each year change, and the month alone between", () => {
    const ticks = [at(2024, 9, 1), at(2025, 0, 1), at(2025, 3, 1), at(2025, 9, 1)];
    const labels = ticks.map((tick, index) => timeTickLabel(tick, index, ticks));
    expect(labels).toEqual(["Oct 2024", "Jan 2025", "Apr", "Oct"]);
  });

  it("writes a week's tick as its day and short month, with the year on the first", () => {
    const ticks = [at(2026, 8, 7), at(2026, 8, 14), at(2026, 8, 21)];
    expect(ticks.map((tick, index) => timeTickLabel(tick, index, ticks))).toEqual([
      "7 Sep 2026",
      "14 Sep",
      "21 Sep",
    ]);
  });

  it("compares a thinned tick with the one the axis draws before it, not the one it dropped", () => {
    // March follows January on the axis, so it is the same year and carries no year.
    expect(timeTickLabel(at(2025, 2, 1), 1, [at(2025, 0, 1), at(2025, 2, 1)])).toBe("Mar");
    // December then February is a year change on the axis, so February names its year.
    expect(timeTickLabel(at(2025, 1, 1), 1, [at(2024, 11, 1), at(2025, 1, 1)])).toBe("Feb 2025");
  });
});

describe("the latest-value label", () => {
  it("carries the short symbol and no words", () => {
    expect(latestFormatter("usd_per_barrel")(78.25)).toBe("US$78.25");
    expect(latestFormatter("sgd_per_usd")(1.35)).toBe("1.35");
    expect(latestFormatter("percent")(7)).toBe("7.00%");
    expect(latestFormatter("widgets_per_frob")(7)).toBe("7");
  });
});

describe("economic units the importers write", () => {
  // The importers are the source of truth for the ids the chat can meet. Each one must name
  // its unit in words, or the subtitle and the readings would print the raw id.
  const economy = path.resolve(
    __dirname,
    "../../../../../../services/jobs/internal/jobs/economy",
  );

  function importerUnits(): Set<string> {
    const ids = new Set<string>();
    const files = fs
      .readdirSync(economy)
      .filter((file) => file.endsWith(".go") && !file.endsWith("_test.go"));
    for (const file of files) {
      const source = fs.readFileSync(path.join(economy, file), "utf8");
      // Keyed fields: Unit: "x" and unit: "x".
      for (const match of source.matchAll(/\b[Uu]nit\s*:\s*"([a-z][a-z0-9_]*)"/g)) {
        ids.add(match[1]!);
      }
      // The CPI importer's tuple, `metric, unit = "annual_change", "percent"`: the unit is second.
      for (const match of source.matchAll(/\bmetric,\s*unit\s*=\s*"[^"]*",\s*"([a-z][a-z0-9_]*)"/g)) {
        ids.add(match[1]!);
      }
      // The pink sheet's positional series rows, where the unit is the fourth field.
      for (const match of source.matchAll(/"(usd_per_[a-z0-9_]+)"/g)) {
        ids.add(match[1]!);
      }
    }
    return ids;
  }

  it("reads the importer sources, so a missing folder cannot pass silently", () => {
    expect(fs.existsSync(economy)).toBe(true);
    expect(importerUnits().size).toBeGreaterThanOrEqual(20);
  });

  it("names every unit id an importer writes in words", () => {
    const missing = [...importerUnits()].filter((unit) => seriesSubtitle(unit) === "");
    expect(missing).toEqual([]);
  });
});

describe("time axis at a phone's width", () => {
  it("keeps every pair of adjacent labels apart at 300px, from a week's range to a year's", () => {
    // A 300px phone's chat chart has a plot of about 210px, once the value axis takes its share.
    const innerW = 210;
    const day = 86_400_000;
    const crowded: string[] = [];
    for (let start = 0; start < 365; start += 5) {
      for (const span of [7, 21, 45, 90, 365]) {
        const from = new Date(2026, 0, 1 + start);
        const to = new Date(from.getTime() + span * day);
        const scale = scaleTime<number>({ domain: [from, to], range: [0, innerW] });
        const ticks = timeTickValues(scale, innerW, { labelChars: 11 });
        const labels = ticks.map((tick, index) => timeTickLabel(tick, index, ticks));
        for (let i = 1; i < ticks.length; i++) {
          const gap = (scale(ticks[i]!) ?? 0) - (scale(ticks[i - 1]!) ?? 0);
          // Half of each label's estimated width, at 6.5px a character, is the room each takes.
          const needed = ((labels[i - 1]!.length + labels[i]!.length) / 2) * 6.5;
          if (gap < needed) crowded.push(`${from.toDateString()} + ${span}d: "${labels[i - 1]}" / "${labels[i]}" ${gap.toFixed(1)}px`);
        }
      }
    }
    expect(crowded).toEqual([]);
  });

  it("writes the year on the first label at 300px, where a 3 Oct 2026 label has room for 5 Oct beside it", () => {
    const innerW = 210;
    const from = new Date(2026, 9, 3);
    const to = new Date(2026, 9, 24);
    const scale = scaleTime<number>({ domain: [from, to], range: [0, innerW] });
    const ticks = timeTickValues(scale, innerW, { labelChars: 11 });
    const labels = ticks.map((tick, index) => timeTickLabel(tick, index, ticks));
    // The first label carries the year, and the next label starts a clear gap after it.
    expect(labels[0]).toMatch(/^\d{1,2} Oct 2026$/);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });
});
