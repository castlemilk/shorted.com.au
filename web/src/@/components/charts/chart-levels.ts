import type { ChartBand, ChartLevel, ChartMarker } from "./types";

export interface LevelGeometry {
  x1: number;
  x2: number;
  y: number;
  label: string;
  color: string;
  dash?: string;
}
export interface BandGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  label?: string;
}
export interface MarkerGeometry {
  x: number;
  label: string;
  color: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Pixel geometry for reference levels, bands and markers, clipped to the
 * inner plot. Pure: the chart hands in its scales and gets back only what is
 * visible, so a base that began before the loaded window clips to the left
 * edge and a level above the plot is simply absent.
 */
export function layoutLevels(opts: {
  levels: ChartLevel[];
  bands: ChartBand[];
  markers: ChartMarker[];
  x: (t: number) => number;
  yFor: (axis: "left" | "right") => (v: number) => number;
  innerW: number;
  innerH: number;
}): { levels: LevelGeometry[]; bands: BandGeometry[]; markers: MarkerGeometry[] } {
  const { innerW, innerH } = opts;
  const span = (from?: number, to?: number): [number, number] | null => {
    const x1 = from === undefined ? 0 : clamp(opts.x(from), 0, innerW);
    const x2 = to === undefined ? innerW : clamp(opts.x(to), 0, innerW);
    return x2 - x1 > 0 ? [x1, x2] : null;
  };

  const levels: LevelGeometry[] = [];
  for (const l of opts.levels) {
    const y = opts.yFor(l.axis)(l.value);
    if (!Number.isFinite(y) || y < 0 || y > innerH) continue;
    const s = span(l.from, l.to);
    if (!s) continue;
    levels.push({ x1: s[0], x2: s[1], y, label: l.label, color: l.color, dash: l.dash });
  }

  const bands: BandGeometry[] = [];
  for (const b of opts.bands) {
    const s = span(b.from, b.to);
    if (!s) continue;
    const yScale = opts.yFor(b.axis);
    const yHigh = clamp(yScale(b.high), 0, innerH);
    const yLow = clamp(yScale(b.low), 0, innerH);
    const height = Math.abs(yLow - yHigh);
    if (height <= 0) continue;
    bands.push({ x: s[0], y: Math.min(yHigh, yLow), width: s[1] - s[0], height, color: b.color, label: b.label });
  }

  const markers: MarkerGeometry[] = [];
  for (const m of opts.markers) {
    const x = opts.x(m.t);
    if (!Number.isFinite(x) || x < 0 || x > innerW) continue;
    markers.push({ x, label: m.label, color: m.color });
  }

  return { levels, bands, markers };
}
