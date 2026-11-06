// The compare page's curves on one shared scale. Pure: no React, no DOM. Every
// curve shares one x (time) and one y (equity) domain, so the lines compare by eye;
// a curve with no finite point draws nothing.

export interface CompareCurveInput {
  key: string;
  points: ReadonlyArray<{ t: number; v: number | null }>;
}

export interface CompareCurvePath {
  key: string;
  /** The SVG path `d`; "" when the curve has no finite point. */
  d: string;
}

export interface CompareGeometry {
  paths: CompareCurvePath[];
  /** The shared y domain, for an axis label; null when no curve has a point. */
  yMin: number | null;
  yMax: number | null;
}

const r = (n: number) => Math.round(n * 100) / 100;

export function compareGeometry(
  curves: readonly CompareCurveInput[],
  width: number,
  height: number,
  pad = 4,
): CompareGeometry {
  const finite = curves.map((curve) =>
    curve.points.filter(
      (p): p is { t: number; v: number } =>
        Number.isFinite(p.t) && p.v !== null && Number.isFinite(p.v),
    ),
  );
  const all = finite.flat();
  if (all.length === 0) {
    return { paths: curves.map((c) => ({ key: c.key, d: "" })), yMin: null, yMax: null };
  }
  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  const vMin = Math.min(...all.map((p) => p.v));
  const vMax = Math.max(...all.map((p) => p.v));
  const tSpan = tMax - tMin || 1;
  const vSpan = vMax - vMin || 1;
  const x = (t: number) => pad + ((t - tMin) / tSpan) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - vMin) / vSpan) * (height - 2 * pad);

  return {
    paths: curves.map((curve, index) => {
      const points = finite[index]!;
      const d = points
        .map((p, i) => `${i === 0 ? "M" : "L"}${r(x(p.t))} ${r(y(p.v))}`)
        .join(" ");
      return { key: curve.key, d };
    }),
    yMin: vMin,
    yMax: vMax,
  };
}
