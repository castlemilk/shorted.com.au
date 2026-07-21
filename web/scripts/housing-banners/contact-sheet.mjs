// Tile the generated banner backgrounds into a single labelled contact sheet for review.
import sharp from "sharp";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES } from "./banner-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

const cellW = 720, imgH = 480, labelH = 36, cellH = imgH + labelH, gap = 14, cols = 2;
const ids = ARCHETYPES.map((a) => a.id).filter((id) => existsSync(join(OUT, `${id}.png`)));
const rows = Math.ceil(ids.length / cols);
const W = cols * cellW + (cols + 1) * gap;
const H = rows * cellH + (rows + 1) * gap;

const composites = [];
for (let i = 0; i < ids.length; i++) {
  const id = ids[i];
  const col = i % cols, row = Math.floor(i / cols);
  const left = gap + col * (cellW + gap);
  const top = gap + row * (cellH + gap);
  const img = await sharp(join(OUT, `${id}.png`)).resize(cellW, imgH, { fit: "cover" }).png().toBuffer();
  composites.push({ input: img, left, top });
  const label = Buffer.from(
    `<svg width="${cellW}" height="${labelH}"><rect width="100%" height="100%" fill="#17120e"/>` +
    `<text x="14" y="24" font-family="ui-monospace, Menlo, monospace" font-size="17" fill="#FFA94D">${id}</text></svg>`
  );
  composites.push({ input: label, left, top: top + imgH });
}

await sharp({ create: { width: W, height: H, channels: 3, background: "#0c0a08" } })
  .composite(composites)
  .png()
  .toFile(join(OUT, "_contact-sheet.png"));
console.error(`contact sheet ${W}x${H} -> ${join(OUT, "_contact-sheet.png")} (${ids.length} scenes)`);
