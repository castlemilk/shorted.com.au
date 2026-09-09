// Quantize the per-state overlay GeoJSON (from overlay_geometry.py) into the
// committed TopoJSON the map draws: web/public/geo/hazards/<STATE>-<layer>.topojson
//
// Each file carries `properties.source`, `properties.licence` and `properties.asOf`
// on the topology so attribution ships with the geometry, and must land under
// MAX_BYTES — the suburb boundaries themselves are ~1.3 MB per big state, and an
// overlay is drawn on top of them, so it does not get to cost more than half that.
// mapshaper's `-simplify` is retried at a lower retention until the budget holds.
//
// Usage: node build-overlays.mjs <overlaysDir> [outDir]
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inDir = resolve(process.argv[2] ?? "/Volumes/gamma-systems-2/shorted-hazards/overlays");
const outDir = resolve(process.argv[3] ?? resolve(here, "../../../public/geo/hazards"));
export const MAX_BYTES = 600_000;
// The satellite layer is a polygonised raster and speckly by nature; it is
// fetched only when toggled on, so it gets a larger budget than a statutory layer.
export const WATER_MAX_BYTES = 1_200_000;

export const LAYER_META = {
  flood_planning: {
    NSW: { source: "NSW Environmental Planning Instrument — Flood (NSW Planning Portal)", licence: "CC-BY-4.0" },
    VIC: { source: "Vicmap Planning overlays LSIO/FO/SBO (DTP Victoria)", licence: "CC-BY-4.0" },
  },
  bushfire_prone: {
    NSW: { source: "NSW Bush Fire Prone Land (NSW Rural Fire Service)", licence: "CC-BY-4.0" },
    VIC: { source: "Vicmap Planning overlay BMO (DTP Victoria)", licence: "CC-BY-4.0" },
  },
  water_observed: {
    "*": { source: "DEA Water Observations Statistics 1987– (Geoscience Australia)", licence: "CC-BY-4.0" },
  },
};

const RETENTION = ["100%", "50%", "25%", "12%", "6%", "3%", "1.5%"];

function build(file) {
  const [state, layerWithExt] = basename(file).split("-");
  const layer = layerWithExt.replace(/\.geojson$/, "");
  const meta = LAYER_META[layer]?.[state] ?? LAYER_META[layer]?.["*"];
  if (!meta) throw new Error(`${file}: no LAYER_META for ${layer}/${state}`);
  const out = resolve(outDir, `${state}-${layer}.topojson`);
  for (const keep of RETENTION) {
    execSync(
      `npx mapshaper-xl 8gb -i "${file}" -simplify ${keep} keep-shapes -o "${out}" format=topojson quantization=1e4`,
      { stdio: "pipe", cwd: resolve(here, "../../..") },
    );
    const bytes = statSync(out).size;
    if (bytes <= (layer === "water_observed" ? WATER_MAX_BYTES : MAX_BYTES)) {
      stamp(out, { layer, state, ...meta, asOf: new Date().toISOString().slice(0, 10), simplify: keep });
      console.log(`${state}-${layer}: ${(bytes / 1024).toFixed(0)} KB (simplify ${keep})`);
      return;
    }
  }
  throw new Error(`${state}-${layer}: still over budget at ${RETENTION.at(-1)}`);
}

function stamp(path, properties) {
  const topo = JSON.parse(readFileSync(path, "utf8"));
  topo.properties = properties;
  writeFileSync(path, JSON.stringify(topo));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(inDir)) throw new Error(`missing ${inDir}`);
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inDir).filter((f) => f.endsWith(".geojson"));
  if (!files.length) throw new Error(`no .geojson in ${inDir}`);
  for (const f of files) build(resolve(inDir, f));
  console.log("done");
}
