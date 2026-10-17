// Quantize the per-state planning overlay GeoJSON (from planning_overlays.py)
// into the committed TopoJSON the map draws:
//   web/public/geo/planning/<STATE>-zoning.topojson    one feature per family
//   web/public/geo/planning/<STATE>-heritage.topojson  one feature
//
// Adapted from ../hazards/build-overlays.mjs (left untouched): same retention
// ladder and the same attribution stamp (`properties.source` / `licence` /
// `asOf` on the topology), with a larger budget because a categorical zoning
// layer is ten dissolved families and is fetched only when toggled on.
//
// Usage: node build-overlays.mjs <overlaysDir> [outDir]
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inDir = resolve(process.argv[2] ?? "/Volumes/gamma-systems-2/shorted-planning/overlays");
const outDir = resolve(process.argv[3] ?? resolve(here, "../../../public/geo/planning"));
export const MAX_BYTES = 1_200_000;

// Licences as each publisher states them: data.nsw publishes the NSW EPI layers
// as license_id 'cc-by' with no version, so they are stamped "CC-BY".
export const LAYER_META = {
  zoning: {
    NSW: { source: "NSW EPI Land Zoning (NSW Planning Portal)", licence: "CC-BY" },
    VIC: { source: "Vicmap Planning — planning scheme zones (DTP Victoria)", licence: "CC-BY-4.0" },
    SA: { source: "SA Planning and Design Code zones (PlanSA)", licence: "CC-BY-3.0-AU" },
    TAS: { source: "Tasmanian Planning Scheme zones + Kingborough Interim Planning Scheme (theLIST)", licence: "CC-BY-3.0-AU" },
    ACT: { source: "ACT Territory Plan land use zones (ACTmapi)", licence: "CC-BY-4.0" },
  },
  heritage: {
    NSW: { source: "NSW EPI Heritage — conservation areas (NSW Planning Portal)", licence: "CC-BY" },
    VIC: { source: "Vicmap Planning Heritage Overlay (DTP Victoria)", licence: "CC-BY-4.0" },
    SA: { source: "SA Planning and Design Code Historic Area / Character Area / State Heritage Area overlays (PlanSA)", licence: "CC-BY-3.0-AU" },
    TAS: { source: "Tasmanian Planning Scheme Local Historic Heritage Code precincts (theLIST)", licence: "CC-BY-3.0-AU" },
    ACT: { source: "ACT Heritage Register — registered historic places (ACTmapi)", licence: "CC-BY-4.0" },
  },
};

const RETENTION = ["100%", "50%", "25%", "12%", "6%", "3%", "1.5%", "0.8%", "0.4%", "0.2%"];

function build(file) {
  const [state, layerWithExt] = basename(file).split("-");
  const layer = layerWithExt.replace(/\.geojson$/, "");
  const meta = LAYER_META[layer]?.[state];
  if (!meta) throw new Error(`${file}: no LAYER_META for ${layer}/${state}`);
  const out = resolve(outDir, `${state}-${layer}.topojson`);
  for (const keep of RETENTION) {
    execSync(
      `npx mapshaper-xl 8gb -i "${file}" -simplify ${keep} keep-shapes -o "${out}" format=topojson quantization=1e5`,
      { stdio: "pipe", cwd: resolve(here, "../../..") },
    );
    const bytes = statSync(out).size;
    if (bytes <= MAX_BYTES) {
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
  const only = process.argv[4] ? new Set(process.argv[4].split(",")) : null;
  const files = readdirSync(inDir).filter((f) => f.endsWith(".geojson") && (!only || only.has(f.split("-")[0])));
  if (!files.length) throw new Error(`no .geojson in ${inDir}`);
  for (const f of files) build(resolve(inDir, f));
  console.log("done");
}
