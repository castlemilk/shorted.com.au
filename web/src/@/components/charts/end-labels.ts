import { LABEL_INSET, spreadLabels } from "./chart-levels";

/** A series' end point, in pixels, and the text that names its final value. */
export interface EndLabelInput {
  id: string;
  /** Pixel y of the series' last point. */
  y: number;
  text: string;
  color: string;
}

export interface EndLabelGeometry {
  id: string;
  /** Right edge of the label (end-anchored), inside the plot. */
  x: number;
  /** Baseline: above the point, spread clear of the other labels. */
  y: number;
  text: string;
  color: string;
}

/** A label's baseline never rises above the top of the plot's first line of type. */
const TOP_BASELINE = 10;

/**
 * Where each series' final value is written: at the right end of the plot,
 * above its last point, and spread apart when two ends sit together. Points
 * the scale cannot place, or that lie outside the plot, get no label. Pure.
 */
export function layoutEndLabels(
  items: readonly EndLabelInput[],
  opts: { innerW: number; innerH: number },
): EndLabelGeometry[] {
  const { innerW, innerH } = opts;
  const visible = items.filter(
    (it) => Number.isFinite(it.y) && it.y >= 0 && it.y <= innerH,
  );
  if (!visible.length) return [];
  const baselines = spreadLabels(
    visible.map((it) => it.y),
    innerH,
  );
  return visible.map((it, i) => ({
    id: it.id,
    x: Math.max(0, innerW - LABEL_INSET),
    y: Math.max(TOP_BASELINE, baselines[i]!),
    text: it.text,
    color: it.color,
  }));
}
