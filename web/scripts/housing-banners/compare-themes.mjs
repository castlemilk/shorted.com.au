// Comparison sheet: [LIGHT theme | DARK theme | SOURCE] per archetype, each tile
// placed on its actual theme page bg so the "melt into page" behaviour is visible.
import sharp from "sharp";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THEME } from "./palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const TONED = join(OUT, "toned");

const ids = (process.env.IDS || "coastal-beach,urban-skyline,inner-terraces,hills-ranges,farmland").split(",");
const cols = [
  { key: "light", title: "LIGHT THEME", bg: THEME.light.pageBg, fg: THEME.light.text, src: (id) => join(TONED, `${id}.light.png`) },
  { key: "dark", title: "DARK THEME", bg: THEME.dark.pageBg, fg: THEME.dark.text, src: (id) => join(TONED, `${id}.dark.png`) },
  { key: "src", title: "SOURCE (gpt-image-1)", bg: "#242018", fg: "#cbb78f", src: (id) => join(OUT, `${id}.png`) },
];

const pad = 26, tileW = 460, tileH = Math.round(tileW * 2 / 3), labelH = 30, headH = 40;
const cellW = tileW + pad * 2, cellH = tileH + pad * 2 + labelH;
const W = cols.length * cellW, H = headH + ids.length * cellH;

const layers = [];
// column headers
for (let c = 0; c < cols.length; c++) {
  layers.push({ input: Buffer.from(
    `<svg width="${cellW}" height="${headH}"><rect width="100%" height="100%" fill="${cols[c].bg}"/>` +
    `<text x="${pad}" y="26" font-family="ui-monospace, Menlo, monospace" font-size="16" fill="${cols[c].fg}">${cols[c].title}</text></svg>`
  ), left: c * cellW, top: 0 });
}
for (let r = 0; r < ids.length; r++) {
  const id = ids[r];
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c];
    const left = c * cellW, top = headH + r * cellH;
    // page-bg panel for the whole cell
    layers.push({ input: Buffer.from(`<svg width="${cellW}" height="${cellH}"><rect width="100%" height="100%" fill="${col.bg}"/></svg>`), left, top });
    if (existsSync(col.src(id))) {
      const tile = await sharp(col.src(id)).resize(tileW, tileH, { fit: "cover" }).png().toBuffer();
      layers.push({ input: tile, left: left + pad, top: top + pad });
    }
    layers.push({ input: Buffer.from(
      `<svg width="${cellW}" height="${labelH}"><text x="${pad}" y="20" font-family="ui-monospace, Menlo, monospace" font-size="14" fill="${col.fg}">${id}</text></svg>`
    ), left, top: top + pad * 2 + tileH - 6 });
  }
}

await sharp({ create: { width: W, height: H, channels: 3, background: "#000" } })
  .composite(layers).png().toFile(join(OUT, "_theme-compare.png"));
console.error(`theme compare ${W}x${H} -> ${join(OUT, "_theme-compare.png")}`);
