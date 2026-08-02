// Politics iconography — high-resolution REVIEW montages of the raw out/ PNGs.
//
// The contact sheet (contact-sheet.mjs) proves the packed sprite slices; this
// proves the ARTWORK. It lays the full-res generations out at 256px on white, in
// batches of 8, so banned imagery (a currency symbol on a parcel, a warning
// mark, a gavel, scales, a trophy) is legible at review size rather than at the
// 16px the icons actually ship at.
//
// Usage: node web/scripts/politics-icons/inspect-montage.mjs [outDir]
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ICONS } from "./icon-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const DEST = resolve(process.argv[2] || join(OUT, "review"));
mkdirSync(DEST, { recursive: true });

const SIZE = 256;
const COLS = 4;
const BATCH = 8;

for (let b = 0; b < ICONS.length; b += BATCH) {
  const batch = ICONS.slice(b, b + BATCH);
  const rows = Math.ceil(batch.length / COLS);
  const composites = [];
  for (let i = 0; i < batch.length; i++) {
    const buf = await sharp(join(OUT, `${batch[i].id}.png`))
      .resize(SIZE, SIZE, { fit: "contain", background: "#ffffff" })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    composites.push({ input: buf, left: (i % COLS) * SIZE, top: Math.floor(i / COLS) * SIZE });
  }
  const file = join(DEST, `review-${String(b).padStart(2, "0")}.png`);
  await sharp({ create: { width: COLS * SIZE, height: rows * SIZE, channels: 3, background: "#ffffff" } })
    .composite(composites)
    .png()
    .toFile(file);
  console.error(`${file}  ${batch.map((x) => x.id).join(" | ")}`);
}
