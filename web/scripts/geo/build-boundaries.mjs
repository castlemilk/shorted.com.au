// Builds committed TopoJSON for the housing map from ABS ASGS 2021 shapefiles.
// States -> public/geo/states.topojson ; Suburbs split per state -> public/geo/suburbs/<STATE>.topojson
// Run: node web/scripts/geo/build-boundaries.mjs
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "src");
const OUT = resolve(here, "../../public/geo");
const OUT_SUBURBS = resolve(OUT, "suburbs");
const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
const MAX_BYTES = 1_400_000; // per-state suburb file budget

// Per-state suburb simplification: the mapshaper `-simplify N%` retains N% of
// vertices, so a LOWER % => more aggressive simplification => smaller file. The
// big mainland states (NSW/VIC/QLD) have thousands of suburbs and need an
// aggressive % to stay within the per-file byte budget; small territories can
// keep far more detail. Values tuned so every output is comfortably < MAX_BYTES.
const SUBURB_SIMPLIFY = {
  NSW: "3%", VIC: "12%", QLD: "7%", SA: "8%",
  WA: "8%", TAS: "10%", NT: "8%", ACT: "8%",
};

const mapshaper = (args) =>
  execSync(`npx mapshaper ${args}`, { stdio: "inherit", cwd: here });

function ensure(path) { if (!existsSync(path)) { console.error(`MISSING input: ${path} — see README`); process.exit(1); } }

mkdirSync(OUT_SUBURBS, { recursive: true });
ensure(resolve(SRC, "STE_2021_AUST_GDA2020.shp"));
ensure(resolve(SRC, "SAL_2021_AUST_GDA2020.shp"));

// States: simplify hard, keep code+name, id = STE_CODE21
mapshaper(
  `-i "${resolve(SRC, "STE_2021_AUST_GDA2020.shp")}" ` +
  `-filter "STE_CODE21 !== '9' && STE_CODE21 !== 'Z'" ` + // drop "Other Territories" + "Outside Australia"
  `-filter-fields STE_CODE21,STE_NAME21 ` +
  `-each "this.id = STE_CODE21" ` +
  `-simplify 4% keep-shapes ` +
  `-o "${resolve(OUT, "states.topojson")}" format=topojson id-field=STE_CODE21 quantization=1e4`
);

// Suburbs: per state, simplify, id = SAL_CODE21, keep name + state
for (const st of STATES) {
  mapshaper(
    `-i "${resolve(SRC, "SAL_2021_AUST_GDA2020.shp")}" ` +
    `-filter "STE_NAME21 === '${stateFullName(st)}'" ` +
    `-filter-fields SAL_CODE21,SAL_NAME21,STE_CODE21 ` +
    `-each "this.id = SAL_CODE21" ` +
    `-simplify ${SUBURB_SIMPLIFY[st]} keep-shapes ` +
    `-o "${resolve(OUT_SUBURBS, st + ".topojson")}" format=topojson id-field=SAL_CODE21 quantization=1e4`
  );
  const f = resolve(OUT_SUBURBS, st + ".topojson");
  const bytes = statSync(f).size;
  console.log(`${st}: ${(bytes / 1024).toFixed(0)} KB`);
  if (bytes > MAX_BYTES) console.warn(`  ⚠ ${st} exceeds ${MAX_BYTES} bytes — raise -simplify % for this state`);
}

function stateFullName(code) {
  return ({ NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland",
    SA: "South Australia", WA: "Western Australia", TAS: "Tasmania",
    NT: "Northern Territory", ACT: "Australian Capital Territory" })[code];
}
console.log("done");
