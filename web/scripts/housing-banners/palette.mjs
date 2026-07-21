// Banner palette system — one luminance master, two theme ramps.
//
// The generated backgrounds are essentially screen-print duotones. Instead of
// maintaining two AI image sets, we decouple TONE (the luminance structure of the
// scene) from COLOR (a theme ramp). A gradient map remaps each luminance level to
// a colour along the ramp. Both ramps share the brand DNA (amber / olive / warm
// brown) but flip value polarity:
//   • LIGHT: highlights → warm cream (≈ the light page bg, so sky melts into page)
//   • DARK:  shadows → near-black (≈ the dark page bg), highlights → glowing amber
//
// Anchored to the app theme tokens (web/src/styles/globals.css):
//   light --background hsl(40 25% 97%) ≈ #F9F7F2, --foreground #4A3B34
//   dark  --background #0C0C0C, --foreground #E8DDB5 (warm sand), --primary #FFA94D
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// stops as [t (0=shadow .. 1=highlight), "#rrggbb"] — warm olive → amber → cream
export const LIGHT_RAMP = [
  [0.00, "#2E2A1E"], // deep olive-brown shadow
  [0.30, "#6B6A38"], // dark olive (foliage)
  [0.52, "#A98B45"], // olive-amber mid
  [0.74, "#E0A857"], // amber
  [1.00, "#F6F1E4"], // warm cream ≈ light page bg
].map(([t, h]) => [t, hex(h)]);

// near-black → bronze → glowing amber → warm sand
export const DARK_RAMP = [
  [0.00, "#0C0C0C"], // = dark page bg (shadows melt into the page)
  [0.26, "#33240F"], // deep umber
  [0.50, "#6E4E20"], // bronze
  [0.72, "#B4793A"], // burnt amber
  [0.88, "#E8A94D"], // glowing amber ≈ dark --primary
  [1.00, "#F3D89B"], // warm sand-amber sky glow ≈ dark --foreground
].map(([t, h]) => [t, hex(h)]);

export const RAMPS = { light: LIGHT_RAMP, dark: DARK_RAMP };

/** Build a 256×3 LUT (Uint8Array) by piecewise-linear RGB interpolation of a ramp. */
export function buildLut(stops) {
  const s = [...stops].sort((a, b) => a[0] - b[0]);
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = s[0], b = s[s.length - 1];
    for (let k = 0; k < s.length - 1; k++) {
      if (t >= s[k][0] && t <= s[k + 1][0]) { a = s[k]; b = s[k + 1]; break; }
    }
    const span = b[0] - a[0] || 1;
    const f = Math.min(1, Math.max(0, (t - a[0]) / span));
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * f);
  }
  return lut;
}

// Handy exports for the mock composite (name/scrim colours per theme).
export const THEME = {
  light: { pageBg: "#F9F7F2", text: "#3A2E22", subText: "#6E5A48", accent: "#B4712A", scrim: "0,0,0" },
  dark: { pageBg: "#0C0C0C", text: "#F1E7C7", subText: "#B9AC86", accent: "#FFA94D", scrim: "0,0,0" },
};
