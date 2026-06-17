import type { ChartPoint, ChartRegion } from "./types";

/** Nearest value in a t-ascending series (binary search). */
function valueAt(points: ChartPoint[], t: number): number | null {
  const n = points.length;
  if (!n) return null;
  if (t <= points[0]!.t) return points[0]!.v;
  if (t >= points[n - 1]!.t) return points[n - 1]!.v;
  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mt = points[mid]!.t;
    if (mt === t) return points[mid]!.v;
    if (mt < t) lo = mid + 1;
    else hi = mid - 1;
  }
  // lo = first point after t, hi = last point before t — pick the nearer.
  const a = points[hi]!;
  const b = points[lo]!;
  return t - a.t <= b.t - t ? a.v : b.v;
}

export interface DivergenceOptions {
  /** Trend window in short-series points (default: adaptive, ~length/12, 5..15). */
  window?: number;
  /** Drop regions spanning fewer than this many short points (default 3). */
  minRun?: number;
}

type Tone = "bearish" | "bullish" | null;

/**
 * Shade spans where short interest and price trend in the SAME direction — the
 * counterintuitive, Shorted-specific regimes a generic charting library can't
 * draw because it doesn't co-locate daily short interest with price:
 *  - "bearish": short ↑ while price ↑  (bears pressing into a rally).
 *  - "bullish": short ↓ while price ↓  (bears covering into a decline).
 * Spans where they move inversely (the normal relationship) or either leg is
 * flat are left unshaded. Slopes are sign-of-delta over a trailing window.
 */
export function computeDivergenceRegions(
  price: ChartPoint[],
  short: ChartPoint[],
  opts: DivergenceOptions = {},
): ChartRegion[] {
  const w = Math.max(
    3,
    opts.window ?? Math.min(15, Math.max(5, Math.round(short.length / 12))),
  );
  const minRun = Math.max(1, opts.minRun ?? 3);
  if (short.length < w + 1 || price.length < 2) return [];

  const toneAt: { t: number; tone: Tone }[] = [];
  for (let i = w; i < short.length; i++) {
    const s0 = short[i - w]!;
    const s1 = short[i]!;
    const dShort = s1.v - s0.v;
    const p0 = valueAt(price, s0.t);
    const p1 = valueAt(price, s1.t);
    if (p0 == null || p1 == null) {
      toneAt.push({ t: s1.t, tone: null });
      continue;
    }
    const dPrice = p1 - p0;
    let tone: Tone = null;
    if (dShort > 0 && dPrice > 0) tone = "bearish";
    else if (dShort < 0 && dPrice < 0) tone = "bullish";
    toneAt.push({ t: s1.t, tone });
  }

  const regions: ChartRegion[] = [];
  let run: { tone: "bearish" | "bullish"; start: number; end: number; n: number } | null = null;
  const flush = () => {
    if (run && run.n >= minRun) {
      regions.push({
        start: run.start,
        end: run.end,
        tone: run.tone,
        label:
          run.tone === "bearish"
            ? "Shorts building into price strength"
            : "Shorts covering into price weakness",
      });
    }
    run = null;
  };
  for (const { t, tone } of toneAt) {
    if (tone == null) {
      flush();
      continue;
    }
    if (run && run.tone === tone) {
      run.end = t;
      run.n += 1;
    } else {
      flush();
      run = { tone, start: t, end: t, n: 1 };
    }
  }
  flush();
  return regions;
}
