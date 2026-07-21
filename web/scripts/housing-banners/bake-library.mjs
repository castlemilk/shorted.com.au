// Crop each 1536x1024 master to a 3:1 banner band, produce the light (source) and
// dark (gradient-map) variants, emit compact AVIF for shipping.
import sharp from "sharp";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES } from "./banner-set.config.mjs";
import { RAMPS, buildLut } from "./palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const DEST = join(HERE, "..", "..", "public", "housing-banners", "bg");
mkdirSync(DEST, { recursive: true });
const BW = 1600, BH = 540; // ~3:1 banner band
const darkLut = buildLut(RAMPS.dark);

async function bandFromMaster(id) {
  const full = await sharp(join(OUT, `${id}.png`)).resize(BW).toBuffer();
  const meta = await sharp(full).metadata();
  const top = Math.round((meta.height - BH) * 0.28);
  return sharp(full).extract({ left: 0, top: Math.max(0, top), width: BW, height: BH });
}

for (const { id } of ARCHETYPES) {
  if (!existsSync(join(OUT, `${id}.png`))) { console.error(`skip ${id} (no master)`); continue; }
  await (await bandFromMaster(id)).avif({ quality: 62 }).toFile(join(DEST, `${id}.light.avif`));
  const band = await (await bandFromMaster(id)).greyscale().linear(1.06, -7.68).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
  const { data, info } = band;
  const rgb = Buffer.allocUnsafe(info.width * info.height * 3);
  for (let i = 0; i < info.width * info.height; i++) { const g = data[i] * 3; rgb[i*3]=darkLut[g]; rgb[i*3+1]=darkLut[g+1]; rgb[i*3+2]=darkLut[g+2]; }
  await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } }).avif({ quality: 62 }).toFile(join(DEST, `${id}.dark.avif`));
  console.error(`baked ${id}`);
}
console.error(`DONE -> ${DEST}`);
