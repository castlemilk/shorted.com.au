import type { ChartPoint } from "./types";

/**
 * Largest-Triangle-Three-Buckets. Returns the kept indices into `points`
 * (ascending). Always keeps first & last. `threshold` is the target point count.
 *
 * Returning indices (not just points) lets callers subsample aligned arrays
 * (e.g. indicator values) by the same selection.
 */
export function lttbIndices(points: ChartPoint[], threshold: number): number[] {
  const n = points.length;
  if (threshold >= n || threshold <= 2 || n <= 2) return points.map((_, i) => i);

  const kept: number[] = [0];
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0; // previously selected index

  for (let i = 0; i < threshold - 2; i++) {
    // current bucket (middle buckets only; never includes the final point)
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, n - 1);

    // average point of the NEXT bucket (clamped so it can reach the last point)
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgRangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    const avgCount = Math.max(1, avgRangeEnd - avgRangeStart);
    let avgT = 0;
    let avgV = 0;
    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgT += points[j]!.t;
      avgV += points[j]!.v;
    }
    avgT /= avgCount;
    avgV /= avgCount;

    const aPt = points[a]!;
    let maxArea = -1;
    let chosen = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const p = points[j]!;
      const area =
        Math.abs(
          (aPt.t - avgT) * (p.v - aPt.v) - (aPt.t - p.t) * (avgV - aPt.v),
        ) / 2;
      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }
    kept.push(chosen);
    a = chosen;
  }
  kept.push(n - 1);
  return kept;
}

export interface DecimateResult {
  points: ChartPoint[];
  indices: number[];
}

/**
 * Decimate `points` to ~`threshold` via LTTB. With `keepExtrema`, force-includes
 * the global max-v and min-v indices so sharp spikes survive downsampling.
 */
export function decimate(
  points: ChartPoint[],
  threshold: number,
  opts: { keepExtrema?: boolean } = {},
): DecimateResult {
  if (points.length <= threshold) {
    return { points, indices: points.map((_, i) => i) };
  }
  let idx = lttbIndices(points, threshold);
  if (opts.keepExtrema && points.length > 2) {
    let maxI = 0;
    let minI = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i]!.v > points[maxI]!.v) maxI = i;
      if (points[i]!.v < points[minI]!.v) minI = i;
    }
    const set = new Set(idx);
    set.add(maxI);
    set.add(minI);
    idx = [...set].sort((x, y) => x - y);
  }
  return { points: idx.map((i) => points[i]!), indices: idx };
}
