// Tile raw generated masters into a labelled review sheet kept under ignored out/.
import sharp from "sharp";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES } from "./banner-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CELL_WIDTH = 720;
const IMAGE_HEIGHT = 480;
const LABEL_HEIGHT = 36;
const CELL_HEIGHT = IMAGE_HEIGHT + LABEL_HEIGHT;
const GAP = 14;
const COLUMNS = 2;
const states = ARCHETYPES.filter(({ id }) =>
  existsSync(join(OUT, `${id}.png`)),
);
const rows = Math.ceil(states.length / COLUMNS);
const width = COLUMNS * CELL_WIDTH + (COLUMNS + 1) * GAP;
const height = rows * CELL_HEIGHT + (rows + 1) * GAP;
const composites = [];

for (let index = 0; index < states.length; index += 1) {
  const { id, name } = states[index];
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const left = GAP + column * (CELL_WIDTH + GAP);
  const top = GAP + row * (CELL_HEIGHT + GAP);
  const image = await sharp(join(OUT, `${id}.png`))
    .resize(CELL_WIDTH, IMAGE_HEIGHT, { fit: "cover" })
    .png()
    .toBuffer();
  composites.push({ input: image, left, top });
  const label = Buffer.from(
    `<svg width="${CELL_WIDTH}" height="${LABEL_HEIGHT}"><rect width="100%" height="100%" fill="#17120e"/><text x="14" y="24" font-family="ui-monospace, Menlo, monospace" font-size="17" fill="#FFA94D">${id.toUpperCase()} — ${name}</text></svg>`,
  );
  composites.push({ input: label, left, top: top + IMAGE_HEIGHT });
}

await sharp({
  create: {
    width,
    height,
    channels: 3,
    background: "#0c0a08",
  },
})
  .composite(composites)
  .png()
  .toFile(join(OUT, "_contact-sheet.png"));
console.error(
  `contact sheet ${width}x${height} -> ${join(OUT, "_contact-sheet.png")} (${states.length} scenes)`,
);
