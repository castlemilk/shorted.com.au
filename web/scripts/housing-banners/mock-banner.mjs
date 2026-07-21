// Full composite banner mock: background + real suburb vector-map snapshot +
// serif name/stat + theme-aware scrim. Proves the whole banner in both themes.
//
//   THEME=dark node web/scripts/housing-banners/mock-banner.mjs
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as topojson from "topojson-client";
import { geoMercator, geoPath, geoBounds, geoCentroid } from "d3-geo";
import { THEME } from "./palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const theme = process.env.THEME === "light" ? "light" : "dark";

// --- demo suburb: Bondi Beach (coastal) ---
const DEMO = { state: "NSW", salId: "10463", name: "Bondi Beach", sub: "New South Wales · Census 2021",
  stat: "Median house $3.28M", statSub: "+4.2% yr · Waverley", archetype: "coastal-beach" };

const W = 1536, H = 512;
const T = THEME[theme];

// ---- 1. vector map snapshot (target suburb highlighted among neighbours) ----
const mapColors = theme === "dark"
  ? { neighbour: "rgba(232,221,181,0.16)", target: "#FFA94D", targetStroke: "#5C3F16", card: "rgba(18,15,11,0.55)", border: "rgba(255,169,77,0.32)" }
  : { neighbour: "rgba(74,59,52,0.22)", target: "#C77A2E", targetStroke: "#5C3B1E", card: "rgba(249,247,242,0.90)", border: "rgba(74,59,52,0.14)" };
const MAP = 360;

function buildMapSvg() {
  const topo = JSON.parse(readFileSync(join(HERE, "..", "..", "public", "geo", "suburbs", `${DEMO.state}.topojson`), "utf8"));
  const obj = Object.keys(topo.objects)[0];
  const feats = topojson.feature(topo, topo.objects[obj]).features;
  const target = feats.find((f) => String(f.id) === DEMO.salId);
  const [[w, s], [e, n]] = geoBounds(target);
  const dw = e - w || 0.02, dh = n - s || 0.02;
  const inView = feats.filter((f) => {
    const [cx, cy] = geoCentroid(f);
    return cx > w - 1.6 * dw && cx < e + 1.6 * dw && cy > s - 1.6 * dh && cy < n + 1.6 * dh;
  });
  const pad = 20;
  const projection = geoMercator().fitExtent([[pad, pad], [MAP - pad, MAP - pad]], { type: "FeatureCollection", features: inView });
  const path = geoPath(projection);
  const others = inView.filter((f) => f !== target).map((f) => `<path d="${path(f)}" fill="none" stroke="${mapColors.neighbour}" stroke-width="1"/>`).join("");
  const tgt = `<path d="${path(target)}" fill="${mapColors.target}" fill-opacity="0.9" stroke="${mapColors.targetStroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${MAP}" height="${MAP}">${others}${tgt}</svg>`);
}

// ---- 2. background: crop the 3:2 source to a 3:1 banner band, tone per theme ----
const bgSrc = theme === "dark" ? join(OUT, "toned", `${DEMO.archetype}.dark.png`) : join(OUT, `${DEMO.archetype}.png`);
const bg = await sharp(bgSrc).resize(W, Math.round(W * 2 / 3)).extract({ left: 0, top: 150, width: W, height: H }).png().toBuffer();

// ---- 3. theme scrim (left→right) so the name zone stays legible ----
const scrimRGB = theme === "dark" ? "12,12,12" : "249,247,242";
const scrim = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>` +
  `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0">` +
  `<stop offset="0" stop-color="rgba(${scrimRGB},0.82)"/>` +
  `<stop offset="0.42" stop-color="rgba(${scrimRGB},0.42)"/>` +
  `<stop offset="0.72" stop-color="rgba(${scrimRGB},0)"/></linearGradient>` +
  `<linearGradient id="v" x1="0" y1="1" x2="0" y2="0">` +
  `<stop offset="0" stop-color="rgba(${scrimRGB},0.55)"/><stop offset="0.5" stop-color="rgba(${scrimRGB},0)"/></linearGradient></defs>` +
  `<rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#v)"/></svg>`
);

// ---- 4. type block ----
const text = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
  `<text x="64" y="150" font-family="Georgia, 'Times New Roman', serif" font-size="30" fill="${T.subText}" letter-spacing="3">HOUSING</text>` +
  `<text x="62" y="250" font-family="Georgia, 'Times New Roman', serif" font-size="86" font-weight="600" fill="${T.text}">${DEMO.name}</text>` +
  `<text x="66" y="300" font-family="ui-monospace, Menlo, monospace" font-size="24" fill="${T.subText}">${DEMO.sub}</text>` +
  `<text x="66" y="372" font-family="ui-monospace, Menlo, monospace" font-size="34" fill="${T.accent}" font-weight="600">${DEMO.stat}</text>` +
  `<text x="66" y="410" font-family="ui-monospace, Menlo, monospace" font-size="22" fill="${T.subText}">${DEMO.statSub}</text></svg>`
);

// ---- 5. map card (rounded panel) + map ----
const mapX = W - 64 - MAP, mapY = (H - MAP) / 2;
const card = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP + 24}" height="${MAP + 24}">` +
  `<rect x="2" y="2" width="${MAP + 20}" height="${MAP + 20}" rx="18" fill="${mapColors.card}" stroke="${mapColors.border}" stroke-width="1.5"/></svg>`
);

const out = join(OUT, `_mock-banner.${theme}.png`);
await sharp(bg)
  .composite([
    { input: scrim, left: 0, top: 0 },
    { input: card, left: mapX - 12, top: mapY - 12 },
    { input: buildMapSvg(), left: mapX, top: mapY },
    { input: text, left: 0, top: 0 },
  ])
  .png().toFile(out);
console.error(`mock ${theme} -> ${out}`);
