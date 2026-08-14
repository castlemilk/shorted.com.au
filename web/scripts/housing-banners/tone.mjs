// Apply the theme gradient-map to the raw AI backgrounds → toned per-theme PNGs.
//
//   node web/scripts/housing-banners/tone.mjs            # both themes, all archetypes
//   THEME=dark ONLY=coastal-beach node .../tone.mjs
import sharp from "sharp";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES } from "./banner-set.config.mjs";
import { RAMPS, buildLut } from "./palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const TONED = join(OUT, "toned");
mkdirSync(TONED, { recursive: true });

const themes = process.env.THEME ? [process.env.THEME] : ["light", "dark"];
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
const CONTRAST = Number(process.env.CONTRAST || 1.06); // gentle S-curve before mapping

const ids = ARCHETYPES.map((a) => a.id).filter((id) => existsSync(join(OUT, `${id}.png`)) && (!ONLY || ONLY.has(id)));
const luts = Object.fromEntries(themes.map((t) => [t, buildLut(RAMPS[t])]));

for (const id of ids) {
  // luminance master: greyscale → single b-w channel, mild contrast to use the full ramp
  const { data, info } = await sharp(join(OUT, `${id}.png`))
    .greyscale()
    .linear(CONTRAST, -(128 * (CONTRAST - 1)))
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  for (const theme of themes) {
    const lut = luts[theme];
    const rgb = Buffer.allocUnsafe(n * 3);
    for (let i = 0; i < n; i++) {
      const g = data[i] * 3;
      rgb[i * 3] = lut[g]; rgb[i * 3 + 1] = lut[g + 1]; rgb[i * 3 + 2] = lut[g + 2];
    }
    await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
      .png().toFile(join(TONED, `${id}.${theme}.png`));
  }
  console.error(`  toned ${id} (${themes.join(", ")})`);
}
console.error(`DONE ${ids.length} archetypes × ${themes.length} themes -> ${TONED}`);
