// Review the shipped light/source and dark-ramp AVIF bands side by side.
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHETYPES } from "./banner-set.config.mjs";
import { THEME } from "./palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const PUBLIC = join(HERE, "..", "..", "public", "economy-banners", "bg");
const TILE_WIDTH = 720;
const TILE_HEIGHT = 243;
const LABEL_HEIGHT = 34;
const GAP = 16;
const COLUMNS = 2;
const rows = ARCHETYPES.length;
const width = COLUMNS * TILE_WIDTH + (COLUMNS + 1) * GAP;
const height = rows * (TILE_HEIGHT + LABEL_HEIGHT) + (rows + 1) * GAP;
const themes = [
  { key: "light", background: THEME.light.pageBg, foreground: THEME.light.text },
  { key: "dark", background: THEME.dark.pageBg, foreground: THEME.dark.text },
];
const composites = [];

for (let row = 0; row < ARCHETYPES.length; row += 1) {
  const { id, name } = ARCHETYPES[row];
  for (let column = 0; column < themes.length; column += 1) {
    const theme = themes[column];
    const left = GAP + column * (TILE_WIDTH + GAP);
    const top = GAP + row * (TILE_HEIGHT + LABEL_HEIGHT + GAP);
    const tile = await sharp(join(PUBLIC, `${id}.${theme.key}.avif`))
      .resize(TILE_WIDTH, TILE_HEIGHT, { fit: "cover" })
      .png()
      .toBuffer();
    composites.push({ input: tile, left, top });
    composites.push({
      input: Buffer.from(
        `<svg width="${TILE_WIDTH}" height="${LABEL_HEIGHT}"><rect width="100%" height="100%" fill="${theme.background}"/><text x="12" y="23" font-family="ui-monospace, Menlo, monospace" font-size="15" fill="${theme.foreground}">${name} — ${theme.key.toUpperCase()}</text></svg>`,
      ),
      left,
      top: top + TILE_HEIGHT,
    });
  }
}

await sharp({
  create: { width, height, channels: 3, background: "#15120e" },
})
  .composite(composites)
  .png()
  .toFile(join(OUT, "_theme-compare.png"));
console.error(`theme comparison ${width}x${height} -> ${join(OUT, "_theme-compare.png")}`);
