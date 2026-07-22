import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ARCHETYPES } from "./banner-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = join(HERE, "..", "..", "public", "economy-banners");
const manifestPath = join(PUBLIC_ROOT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const rows = [];

for (const { id } of ARCHETYPES) {
  assert.deepEqual(Object.keys(manifest[id]).sort(), ["dark", "light"]);
  const themeBuffers = {};
  const row = { id };
  for (const theme of ["light", "dark"]) {
    const relativePath = manifest[id][theme];
    const absolutePath = join(PUBLIC_ROOT, relativePath.split("/").at(-1) === "manifest.json"
      ? "manifest.json"
      : relativePath.replace(/^\/economy-banners\//, ""));
    assert.equal(existsSync(absolutePath), true, `missing ${absolutePath}`);
    const metadata = await sharp(absolutePath).metadata();
    assert.equal(metadata.width, 1600, `${id}.${theme} width`);
    assert.equal(metadata.height, 540, `${id}.${theme} height`);
    assert.equal(metadata.format, "heif", `${id}.${theme} format`);
    themeBuffers[theme] = await sharp(absolutePath)
      .resize(64, 22, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
    row[`${theme}KiB`] = Number((statSync(absolutePath).size / 1024).toFixed(1));
  }

  let totalDelta = 0;
  for (let index = 0; index < themeBuffers.light.length; index += 1) {
    totalDelta += Math.abs(themeBuffers.light[index] - themeBuffers.dark[index]);
  }
  row.themeMeanAbsoluteDelta = Number(
    (totalDelta / themeBuffers.light.length).toFixed(1),
  );
  assert.ok(
    row.themeMeanAbsoluteDelta >= 20,
    `${id} light/dark treatment is insufficiently distinct`,
  );
  rows.push(row);
}

assert.deepEqual(
  Object.keys(manifest).sort(),
  ARCHETYPES.map(({ id }) => id).sort(),
);
console.table(rows);
console.error(`verified ${rows.length * 2} landscape AVIF assets and ${manifestPath}`);
