// Crop each 1536x1024 master to the housing 1600x540 banner band, preserve the
// warm source tone for light, apply the shared dark ramp for dark, and emit AVIF.
import sharp from "sharp";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES } from "./banner-set.config.mjs";
import { RAMPS, buildLut } from "./palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const PUBLIC_ROOT = join(HERE, "..", "..", "public", "economy-banners");
const DEST = join(PUBLIC_ROOT, "bg");
mkdirSync(DEST, { recursive: true });

const BANNER_WIDTH = 1600;
const BANNER_HEIGHT = 540;
const darkLut = buildLut(RAMPS.dark);

async function bandFromMaster(id) {
  const full = await sharp(join(OUT, `${id}.png`))
    .resize(BANNER_WIDTH)
    .toBuffer();
  const metadata = await sharp(full).metadata();
  const top = Math.round((metadata.height - BANNER_HEIGHT) * 0.28);
  return sharp(full).extract({
    left: 0,
    top: Math.max(0, top),
    width: BANNER_WIDTH,
    height: BANNER_HEIGHT,
  });
}

async function applyDarkLut(pipeline) {
  const { data, info } = await pipeline
    .greyscale()
    .linear(1.06, -7.68)
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = Buffer.allocUnsafe(info.width * info.height * 3);
  for (let index = 0; index < info.width * info.height; index += 1) {
    const value = data[index] * 3;
    rgb[index * 3] = darkLut[value];
    rgb[index * 3 + 1] = darkLut[value + 1];
    rgb[index * 3 + 2] = darkLut[value + 2];
  }
  return sharp(rgb, {
    raw: { width: info.width, height: info.height, channels: 3 },
  });
}

const manifest = {};
for (const { id } of ARCHETYPES) {
  const master = join(OUT, `${id}.png`);
  if (!existsSync(master)) {
    throw new Error(`missing raw master for ${id}: ${master}`);
  }

  const lightName = `${id}.light.avif`;
  const darkName = `${id}.dark.avif`;
  await (await bandFromMaster(id))
    .avif({ quality: 62 })
    .toFile(join(DEST, lightName));
  const darkBand = await applyDarkLut(await bandFromMaster(id));
  await darkBand.avif({ quality: 62 }).toFile(join(DEST, darkName));
  manifest[id] = {
    light: `/economy-banners/bg/${lightName}`,
    dark: `/economy-banners/bg/${darkName}`,
  };
  console.error(`  baked ${id}`);
}

writeFileSync(
  join(PUBLIC_ROOT, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.error(`DONE -> ${DEST}, ${join(PUBLIC_ROOT, "manifest.json")}`);
