// Apply the shared theme gradient maps to raw masters for full-frame review.
// Shipping assets are produced by bake-library.mjs, where light preserves the
// generated source tone and dark uses the shared dark ramp, as housing does.
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
const ONLY = process.env.ONLY
  ? new Set(process.env.ONLY.split(",").map((value) => value.trim()))
  : null;
const CONTRAST = Number(process.env.CONTRAST || 1.06);
const ids = ARCHETYPES.map(({ id }) => id).filter(
  (id) => existsSync(join(OUT, `${id}.png`)) && (!ONLY || ONLY.has(id)),
);
const luts = Object.fromEntries(
  themes.map((theme) => [theme, buildLut(RAMPS[theme])]),
);

for (const id of ids) {
  const { data, info } = await sharp(join(OUT, `${id}.png`))
    .greyscale()
    .linear(CONTRAST, -(128 * (CONTRAST - 1)))
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;

  for (const theme of themes) {
    const lut = luts[theme];
    const rgb = Buffer.allocUnsafe(pixels * 3);
    for (let index = 0; index < pixels; index += 1) {
      const value = data[index] * 3;
      rgb[index * 3] = lut[value];
      rgb[index * 3 + 1] = lut[value + 1];
      rgb[index * 3 + 2] = lut[value + 2];
    }
    await sharp(rgb, {
      raw: { width: info.width, height: info.height, channels: 3 },
    })
      .png()
      .toFile(join(TONED, `${id}.${theme}.png`));
  }
  console.error(`  toned ${id} (${themes.join(", ")})`);
}

console.error(
  `DONE ${ids.length} states × ${themes.length} themes -> ${TONED}`,
);
