// The strategy scenes: generative art drawn from each strategy's mechanism.
//
// One pure function per strategy turns a box (width, height in scene units)
// and a time (seconds) into a list of SVG paths. Three renderers share it:
// the server-rendered SVG still in the ISR HTML (components/picks/
// strategy-scene.tsx), the Canvas 2D animation that takes over in the
// browser (strategy-scene-canvas.tsx, a few kilobytes, no WebGL, no three.js)
// and the satori share card (lib/og/card.tsx). Serialisable in and out, no
// DOM, no React, no randomness beyond a seeded hash, so the same (slug, box,
// t) always draws the same frame and a test can pin it.
//
// Each scene is the strategy's engraved glyph (./glyphs.ts) at scene scale,
// the way the housing banners are the housing icons at scene scale:
//
//   zanger-breakout          the weir: price traces held in a tight base
//                            under the pivot, one plume breaking over it on
//                            a volume spike
//   canslim                  the staircase: earnings risers growing, the top
//                            step clearing the prior high, a marker climbing
//   minervini-trend-template the fan: the 200, 150 and 50-day ridges stacked
//                            and fanning apart as they rise, price riding
//                            the top one
//   crowded-short-breakout   the coil: a spring compressed under a plate by
//                            the crowd of short positions, then the release
//   quality-compounders      the meter: a bench gauge whose needle settles on
//                            a high reading, over compounding curves
//
// Tones are the theme's own colours (ink, amber, olive, rust, muted), never
// market red or green: a scene is a mechanism, not a price move. Everything
// is hairline and flat; the only lit element is the amber of the strategy's
// moment (the plume, the marker, the release, the needle's band).

export type SceneTone = "ink" | "amber" | "olive" | "rust" | "muted";

export interface ScenePath {
  /** SVG path data, in scene units. */
  d: string;
  tone: SceneTone;
  /** Stroke width in CSS pixels (non-scaling), ignored for a fill. */
  width: number;
  opacity: number;
  fill: boolean;
  /** stroke-dasharray, in scene units. */
  dash?: string;
  /** stroke-dashoffset, in scene units. */
  dashOffset?: number;
}

export interface SceneFrame {
  width: number;
  height: number;
  paths: ScenePath[];
}

/** The scene's height in units; the width follows the box's aspect ratio. */
export const SCENE_UNIT_HEIGHT = 120;

/** The two boxes the site draws: the header band (3:1) and the hub plate (3:2). */
export const SCENE_BOXES = {
  band: { width: 360, height: SCENE_UNIT_HEIGHT },
  plate: { width: 180, height: SCENE_UNIT_HEIGHT },
} as const;

export type SceneVariant = keyof typeof SCENE_BOXES;

/**
 * The time each still is taken at: the frame that shows the strategy's
 * moment (the plume over the pivot, the plate just released, the needle
 * settled), so the no-JS reader, the crawler and the share card get the
 * scene at its most legible.
 */
export const SCENE_STILL_TIME: Record<string, number> = {
  "zanger-breakout": 5.3,
  canslim: 4.6,
  "minervini-trend-template": 0,
  "crowded-short-breakout": 5.5,
  "quality-compounders": 3.2,
};

// ---------------------------------------------------------------- numbers

/** A deterministic 0..1 for an integer lattice point and a seed. */
function hash(i: number, seed: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 1-D value noise, 0..1, smooth between lattice points. */
function noise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}

/** Three octaves of value noise, 0..1. */
function fbm(x: number, seed: number): number {
  return (noise(x, seed) * 4 + noise(x * 2.1, seed + 11) * 2 + noise(x * 4.3, seed + 23)) / 7;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 0 before a, 1 after b, smooth between. */
function smooth(v: number, a: number, b: number): number {
  const u = clamp((v - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

const n = (v: number) => (Math.round(v * 10) / 10).toString();

function polyline(points: Array<[number, number]>, close = false): string {
  if (points.length === 0) return "";
  let d = `M${n(points[0]![0])} ${n(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) d += `L${n(points[i]![0])} ${n(points[i]![1])}`;
  return close ? `${d}Z` : d;
}

function line(x1: number, y1: number, x2: number, y2: number): string {
  return `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`;
}

function circle(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;
}

/** A point `u` (0..1) of the way along a polyline, by length. */
function alongPolyline(points: Array<[number, number]>, u: number): [number, number] {
  let total = 0;
  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    lengths.push(l);
    total += l;
  }
  let target = clamp(u, 0, 1) * total;
  for (let i = 1; i < points.length; i++) {
    const l = lengths[i - 1]!;
    if (target <= l || i === points.length - 1) {
      const f = l === 0 ? 0 : clamp(target / l, 0, 1);
      return [
        points[i - 1]![0] + (points[i]![0] - points[i - 1]![0]) * f,
        points[i - 1]![1] + (points[i]![1] - points[i - 1]![1]) * f,
      ];
    }
    target -= l;
  }
  return points[points.length - 1]!;
}

const stroke = (
  d: string,
  tone: SceneTone,
  width: number,
  opacity = 1,
  extra: Partial<Pick<ScenePath, "dash" | "dashOffset">> = {},
): ScenePath => ({ d, tone, width, opacity, fill: false, ...extra });

const fill = (d: string, tone: SceneTone, opacity: number): ScenePath => ({
  d,
  tone,
  width: 0,
  opacity,
  fill: true,
});

// ---------------------------------------------------------------- the scenes

type SceneFn = (w: number, h: number, t: number) => ScenePath[];

/** The weir: a tight base under the pivot, one plume over it on volume. */
function zangerBreakout(w: number, h: number, t: number): ScenePath[] {
  const out: ScenePath[] = [];
  const x0 = 0.06 * w;
  const x1 = 0.94 * w;
  const pivot = 0.4 * h;
  const floor = 0.92 * h;
  const baseEnd = 0.7 * w;
  // A seven-second cycle: the base holds, the plume rises through the
  // pivot, holds, and the traces settle back.
  const cyc = mod(t, 7);
  const env = smooth(cyc, 4.2, 5.0) * (1 - smooth(cyc, 6.4, 7.0));

  // The floor and the pivot: the two levels the strategy reads.
  out.push(stroke(line(x0, floor, x1, floor), "muted", 1, 0.6));
  out.push(stroke(line(x0, pivot, x1, pivot), "ink", 1.2, 0.85));

  // Six traces held in the base: contained between the pivot and the base
  // low, drifting with time but never through the pivot.
  const traces = 6;
  const steps = 36;
  let lastPoint: [number, number] = [baseEnd, pivot + 0.1 * h];
  for (let k = 0; k < traces; k++) {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((baseEnd - x0) * i) / steps;
      const drift = fbm(i * 0.22 + t * 0.18 + k * 3.7, 101 + k);
      const y = pivot + 0.05 * h + (0.03 * k + 0.22 * drift) * h;
      pts.push([x, clamp(y, pivot + 0.04 * h, floor - 0.14 * h)]);
    }
    if (k === 0) lastPoint = pts[pts.length - 1]!;
    out.push(stroke(polyline(pts), k === 0 ? "ink" : "muted", 1, k === 0 ? 0.9 : 0.45));
  }

  // The plume: trace 0 continues past the base and, on the cycle's
  // breakout, climbs through the pivot.
  const plume: Array<[number, number]> = [lastPoint];
  const plumeSteps = 14;
  for (let i = 1; i <= plumeSteps; i++) {
    const u = i / plumeSteps;
    const x = baseEnd + (x1 - baseEnd) * u;
    const rise = env * smooth(u, 0.15, 0.85) * 0.3 * h;
    const wobble = (fbm(i * 0.5 + t * 0.3, 7) - 0.5) * 0.03 * h;
    plume.push([x, lastPoint[1] - rise + wobble]);
  }
  out.push(stroke(polyline(plume), env > 0.05 ? "amber" : "ink", 1.6, 0.75 + 0.25 * env));

  // Volume on the floor: ordinary bars, and the breakout session's tall one.
  const bars = 18;
  const slot = (x1 - x0) / bars;
  for (let i = 0; i < bars; i++) {
    const x = x0 + slot * (i + 0.25);
    const quiet = 0.035 * h + hash(i, 41) * 0.07 * h;
    const spike = i >= bars - 3 ? env * (0.16 + 0.1 * hash(i, 43)) * h : 0;
    const height = quiet + spike;
    const d = polyline(
      [
        [x, floor - 0.5],
        [x + slot * 0.5, floor - 0.5],
        [x + slot * 0.5, floor - height],
        [x, floor - height],
      ],
      true,
    );
    out.push(fill(d, spike > 0.01 * h ? "amber" : "muted", spike > 0.01 * h ? 0.75 : 0.35));
  }
  return out;
}

/** The staircase: risers that grow, the top one clearing the prior high. */
function canslim(w: number, h: number, t: number): ScenePath[] {
  const out: ScenePath[] = [];
  const steps = 5;
  const left = 0.1 * w;
  const right = 0.9 * w;
  const treadW = (right - left) / steps;
  const baseY = 0.88 * h;
  const pts: Array<[number, number]> = [[left, baseY]];
  let y = baseY;
  let x = left;
  let priorHigh = baseY;
  for (let k = 0; k < steps; k++) {
    // Each riser 1.32x the one before (earnings accelerating), breathing
    // a little so the climb is alive.
    const riser = 0.074 * h * Math.pow(1.32, k) * (1 + 0.03 * Math.sin(t * 1.1 + k));
    y -= riser;
    if (k === steps - 2) priorHigh = y;
    pts.push([x, y]);
    x += treadW;
    pts.push([x, y]);
  }
  // The ground under the stairs, and the stairs themselves.
  out.push(fill(polyline([...pts, [right, baseY]], true), "olive", 0.12));
  out.push(stroke(line(0.06 * w, baseY, 0.94 * w, baseY), "muted", 1, 0.6));
  out.push(stroke(polyline(pts), "ink", 1.4, 0.9));
  // The prior high the top step clears, dashed, as the table draws a
  // level a stock has yet to pass.
  out.push(stroke(line(0.06 * w, priorHigh - 0.06 * h, 0.94 * w, priorHigh - 0.06 * h), "muted", 1, 0.8, { dash: "4 3" }));
  // The climber: an amber marker walking up the stairs every six seconds,
  // pausing on each tread.
  const u = smooth(mod(t, 6) / 6, 0.05, 0.92);
  const [mx, my] = alongPolyline(pts, u);
  out.push(fill(circle(mx, my - 2.2, 2.4), "amber", 1));
  out.push(stroke(circle(mx, my - 2.2, 4.6), "amber", 1, 0.45));
  return out;
}

/** The fan: three ridges stacked in order, fanning apart as they rise. */
function minervini(w: number, h: number, t: number): ScenePath[] {
  const out: ScenePath[] = [];
  const steps = 40;
  const ridge = (k: number, x: number) => {
    const u = x / w;
    const base = (0.9 - 0.08 * k) * h;
    const slope = (0.16 + 0.08 * k) * h;
    const breathe = 1 + 0.04 * Math.sin(t * 0.5 + k);
    const relief = (fbm(u * 6 + t * 0.06 + k * 9, 211 + k) - 0.5) * (0.06 + 0.02 * k) * h;
    return base - slope * u * breathe + relief;
  };
  // The 200, 150 and 50-day ridges, lowest and gentlest first; each is a
  // filled terrace with a hairline crest.
  for (let k = 0; k < 3; k++) {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const x = (w * i) / steps;
      pts.push([x, ridge(k, x)]);
    }
    out.push(fill(polyline([...pts, [w, h], [0, h]], true), "olive", 0.07 + 0.05 * k));
    out.push(stroke(polyline(pts), "ink", 1, 0.5 + 0.2 * k));
  }
  // Price riding above the 50-day, nearer its high as it goes right.
  const price: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const x = (w * i) / steps;
    const lift = (0.05 + 0.04 * (i / steps)) * h;
    const jitter = (fbm(i * 0.6 + t * 0.4, 307) - 0.5) * 0.07 * h;
    price.push([x, ridge(2, x) - lift + jitter]);
  }
  out.push(stroke(polyline(price), "amber", 1.5, 0.9));
  return out;
}

/** The coil: a spring compressed under a plate, then released. */
function crowdedShort(w: number, h: number, t: number): ScenePath[] {
  const out: ScenePath[] = [];
  const cx = 0.5 * w;
  const floor = 0.9 * h;
  // A seven-second cycle: five seconds of compression, a snap, a settle.
  const cyc = mod(t, 7);
  let c: number;
  if (cyc < 5.2) {
    c = Math.pow(smooth(cyc, 0, 5.2), 1.4);
  } else if (cyc < 5.7) {
    // The snap: eased out with overshoot, so the coil stretches past its
    // rest length before it settles.
    const u = (cyc - 5.2) / 0.5 - 1;
    const back = 1 + 2.70158 * u * u * u + 1.70158 * u * u;
    c = 1 - back;
  } else {
    c = -0.1 * Math.exp(-(cyc - 5.7) * 3) * Math.cos((cyc - 5.7) * 9);
  }
  const release = cyc >= 5.2 ? Math.max(0, 1 - (cyc - 5.2) / 1.5) : 0;
  const restH = 0.46 * h;
  const coilH = restH * (1 - 0.6 * c);
  const plateY = floor - coilH - 0.02 * h;

  out.push(stroke(line(0.06 * w, floor, 0.94 * w, floor), "muted", 1, 0.6));
  // The spring: nine turns between the floor and the plate.
  const turns = 9;
  const amp = 0.07 * w;
  const coil: Array<[number, number]> = [[cx, floor]];
  for (let i = 1; i <= turns * 2; i++) {
    const y = floor - (coilH * i) / (turns * 2);
    coil.push([cx + (i % 2 ? amp : -amp), y]);
  }
  coil.push([cx, floor - coilH]);
  out.push(stroke(polyline(coil), "ink", 1.5, 0.9));
  // The plate (resistance), heavy.
  out.push(stroke(line(cx - 0.2 * w, plateY, cx + 0.2 * w, plateY), "ink", 3, 0.95));

  // The crowd: short positions pressing down on the plate while it is
  // being compressed, turning into covering as it releases.
  const ticks = 12;
  const pressure = clamp(c, 0, 1);
  for (let i = 0; i < ticks; i++) {
    const row = i % 2;
    const col = Math.floor(i / 2);
    const x = cx - 0.17 * w + (0.34 * w * (col + 0.5)) / (ticks / 2) + (row ? 0.015 * w : 0);
    const y = plateY - 0.07 * h - row * 0.08 * h - (1 - pressure) * 0.04 * h - release * 0.22 * h;
    const s = 0.012 * w;
    const d = release > 0.05
      ? polyline([[x - s, y + s], [x, y - s], [x + s, y + s]])
      : polyline([[x - s, y - s], [x, y + s], [x + s, y - s]]);
    const tone: SceneTone = release > 0.05 ? "amber" : "rust";
    out.push(stroke(d, tone, 1.2, release > 0.05 ? 0.4 + 0.6 * release : 0.25 + 0.65 * pressure));
  }
  // The burst: strokes escaping upward through the plate on release.
  if (release > 0.02) {
    for (let i = 0; i < 7; i++) {
      const x = cx + ((i - 3) / 3) * 0.16 * w;
      const len = release * (0.18 + 0.12 * hash(i, 77)) * h * (1 - Math.abs(i - 3) / 6);
      out.push(stroke(line(x, plateY - 0.03 * h, x, plateY - 0.03 * h - len), "amber", 1.4, release));
    }
  }
  return out;
}

/** The meter: a bench gauge settling on a high reading, over compounding curves. */
function qualityCompounders(w: number, h: number, t: number): ScenePath[] {
  const out: ScenePath[] = [];
  const cx = 0.5 * w;
  const cy = 0.86 * h;
  const r = 0.62 * h;
  const deg = (a: number) => (a * Math.PI) / 180;
  const at = (a: number, rr: number): [number, number] => [cx + rr * Math.cos(deg(a)), cy + rr * Math.sin(deg(a))];

  // Compounding curves behind the dial, crawling slowly as they are drawn.
  for (let k = 0; k < 3; k++) {
    const pts: Array<[number, number]> = [];
    const steps = 30;
    const amp = (0.25 + 0.18 * k) * h;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      pts.push([0.06 * w + 0.88 * w * u, 0.94 * h - amp * (Math.exp(2.2 * u) - 1) / (Math.exp(2.2) - 1)]);
    }
    out.push(stroke(polyline(pts), "olive", 1, 0.35, { dash: "5 4", dashOffset: -t * 6 - k * 3 }));
  }

  // The dial: an arc over the top, ticks, and the quality band near the end.
  const a0 = 200;
  const a1 = 340;
  const [sx, sy] = at(a0, r);
  const [ex, ey] = at(a1, r);
  out.push(stroke(`M${n(sx)} ${n(sy)}A${n(r)} ${n(r)} 0 0 1 ${n(ex)} ${n(ey)}`, "ink", 1.4, 0.9));
  for (let a = a0; a <= a1; a += 10) {
    const major = (a - a0) % 30 === 0;
    const [tx1, ty1] = at(a, r);
    const [tx2, ty2] = at(a, r - (major ? 0.07 : 0.04) * h);
    out.push(stroke(line(tx1, ty1, tx2, ty2), "ink", major ? 1.2 : 1, major ? 0.8 : 0.5));
  }
  const [bx, by] = at(300, r - 0.025 * h);
  const [bex, bey] = at(a1, r - 0.025 * h);
  out.push(stroke(`M${n(bx)} ${n(by)}A${n(r - 0.025 * h)} ${n(r - 0.025 * h)} 0 0 1 ${n(bex)} ${n(bey)}`, "amber", 3, 0.7));

  // The needle: dropped to the left at the start of each eight-second
  // cycle, swinging up and settling on the high reading.
  const cyc = mod(t, 8);
  const start = 212;
  const target = 322;
  const angle = target + (start - target) * Math.exp(-2.2 * cyc) * Math.cos(5 * cyc);
  const [nx, ny] = at(angle, r * 0.9);
  out.push(stroke(line(cx, cy, nx, ny), "rust", 1.6, 0.95));
  out.push(fill(circle(cx, cy, 3), "amber", 1));
  out.push(stroke(circle(cx, cy, 5.5), "ink", 1, 0.6));
  out.push(stroke(line(0.06 * w, 0.94 * h, 0.94 * w, 0.94 * h), "muted", 1, 0.6));
  return out;
}

const SCENES: Record<string, SceneFn> = {
  "zanger-breakout": zangerBreakout,
  canslim,
  "minervini-trend-template": minervini,
  "crowded-short-breakout": crowdedShort,
  "quality-compounders": qualityCompounders,
};

/** Whether a strategy has a scene. */
export function hasScene(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(SCENES, slug);
}

/** One frame of a strategy's scene, at time t (seconds), in a w x h box. */
export function sceneFrame(slug: string, width: number, height: number, t: number): SceneFrame {
  const fn = hasScene(slug) ? SCENES[slug]! : null;
  const safeT = Number.isFinite(t) ? t : 0;
  return {
    width,
    height,
    paths: fn ? fn(width, height, safeT) : [],
  };
}

/** The still frame of a scene: the frame at SCENE_STILL_TIME. */
export function sceneStill(slug: string, variant: SceneVariant): SceneFrame {
  const box = SCENE_BOXES[variant];
  return sceneFrame(slug, box.width, box.height, SCENE_STILL_TIME[slug] ?? 0);
}
