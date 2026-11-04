/// <reference types="jest" />

/**
 * Kind colours on a leash (backlog A3). A kind is a category, so each kind keeps its own hue, but
 * the amber selection must stay the brightest and the only warm-orange mark on a view. Three caps
 * hold in both themes, for every kind's light and dark swatch:
 *
 *  1. HSL chroma C = s x (1 - |2l - 1|) is at most 0.45.
 *  2. C is under the theme's amber chroma minus 0.1 (light amber hsl(28 82% 34%), C 0.56; dark amber
 *     hsl(32 100% 65%), C 0.70).
 *  3. No kind sits within 20 degrees of the amber's hue (28 to 32), so hue 8 to 52, unless its C is
 *     at most 0.30.
 *
 * The table is printed so a reviewer can read every kind's hex, hue and chroma in one place.
 */

import { KIND_INFO, type OwnershipKind } from "../kinds";

type Theme = "light" | "dark";

interface Colour {
  hex: string;
  hue: number;
  saturation: number;
  lightness: number;
  chroma: number;
}

/** The hex a swatch names: the first one is the light hex, a `dark:` one is the dark hex. */
function swatchHex(swatch: string, theme: Theme): string {
  const light = /(?:^|\s)bg-\[(#[0-9A-Fa-f]{6})\]/.exec(swatch)?.[1];
  const dark = /dark:bg-\[(#[0-9A-Fa-f]{6})\]/.exec(swatch)?.[1];
  if (light === undefined) throw new Error(`no light hex in "${swatch}"`);
  return theme === "dark" ? (dark ?? light) : light;
}

/** A hex as HSL, with the chroma the cap is written in. */
function hexToColour(hex: string): Colour {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const chroma = saturation * (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return { hex, hue: (hue * 60 + 360) % 360, saturation, lightness, chroma };
}

/** An sRGB channel as linear light, for the CIE76 distance. */
function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** CIE L*a*b* of a hex (D65), the space a colour difference is measured in. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** The CIE76 difference between two hexes: about 2.3 is a just-noticeable step. */
function cie76(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const MIN_DARK_DISTANCE = 9;

/** The amber selection's chroma, from its HSL as the design writes it (DESIGN.md). */
function hslChroma(saturation: number, lightness: number): number {
  return saturation * (1 - Math.abs(2 * lightness - 1));
}

const AMBER_CHROMA: Readonly<Record<Theme, number>> = {
  light: hslChroma(0.82, 0.34),
  dark: hslChroma(1, 0.65),
};

const CHROMA_CAP = 0.45;
const SECOND_CAP_MARGIN = 0.1;
const WARM_BAND: readonly [number, number] = [8, 52];
const BAND_CHROMA_CAP = 0.3;

interface Row {
  kind: string;
  theme: Theme;
  hex: string;
  hue: number;
  chroma: number;
  amberChroma: number;
  inBand: boolean;
}

// Built from KIND_INFO, not the display order, so a kind added to the colour table is measured
// whether or not it has been placed in KIND_ORDER.
const ROWS: Row[] = (Object.keys(KIND_INFO) as OwnershipKind[]).flatMap((kind) =>
  (["light", "dark"] as const).map((theme) => {
    const colour = hexToColour(swatchHex(KIND_INFO[kind].swatch, theme));
    return {
      kind,
      theme,
      hex: colour.hex,
      hue: Math.round(colour.hue),
      chroma: Number(colour.chroma.toFixed(3)),
      amberChroma: Number(AMBER_CHROMA[theme].toFixed(3)),
      inBand: colour.hue >= WARM_BAND[0] && colour.hue <= WARM_BAND[1],
    };
  }),
);

describe("kind chroma on a leash (backlog A3)", () => {
  beforeAll(() => {
    // The table a reviewer reads: every kind in both themes, its hex, hue and chroma.
    console.table(
      ROWS.map((row) => ({
        kind: row.kind,
        theme: row.theme,
        hex: row.hex,
        hue: row.hue,
        chroma: row.chroma,
        "amber C": row.amberChroma,
        "in amber band": row.inBand ? "yes" : "no",
      })),
    );
  });

  it("states the amber's chroma in both themes, so the cap is measured against the real selection", () => {
    expect(AMBER_CHROMA.light).toBeCloseTo(0.5576, 3);
    expect(AMBER_CHROMA.dark).toBeCloseTo(0.7, 3);
  });

  it.each(ROWS.map((row) => [`${row.kind} (${row.theme})`, row] as const))(
    "%s: chroma is at most 0.45",
    (_label, row) => {
      expect(row.chroma).toBeLessThanOrEqual(CHROMA_CAP);
    },
  );

  it.each(ROWS.map((row) => [`${row.kind} (${row.theme})`, row] as const))(
    "%s: chroma is under the amber's minus 0.1, so the selection is the brightest",
    (_label, row) => {
      expect(row.chroma).toBeLessThan(row.amberChroma - SECOND_CAP_MARGIN);
    },
  );

  it.each(ROWS.map((row) => [`${row.kind} (${row.theme})`, row] as const))(
    "%s: a hue within 20 degrees of the amber (28 to 32) carries chroma of at most 0.30",
    (_label, row) => {
      if (row.inBand) expect(row.chroma).toBeLessThanOrEqual(BAND_CHROMA_CAP);
    },
  );

  it("covers every kind in both themes, so the table is complete", () => {
    expect(ROWS).toHaveLength(Object.keys(KIND_INFO).length * 2);
  });

  it("keeps every pair of dark kinds at a CIE76 distance of 9 or more, so no two read as one colour", () => {
    // The brief's own greens sit at 9.6, the closest pair. The light theme is not held to this: its
    // closest pair (the two greens) is 8.4, the brief's own starting point.
    const dark = ROWS.filter((row) => row.theme === "dark");
    const close: string[] = [];
    for (let i = 0; i < dark.length; i++) {
      for (let j = i + 1; j < dark.length; j++) {
        const distance = cie76(dark[i]!.hex, dark[j]!.hex);
        if (distance < MIN_DARK_DISTANCE) close.push(`${dark[i]!.kind}/${dark[j]!.kind} ${distance.toFixed(1)}`);
      }
    }
    expect(close).toEqual([]);
  });
});
