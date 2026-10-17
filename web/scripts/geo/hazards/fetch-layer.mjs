// Page a public ArcGIS REST layer or an OGC WFS 2.0 layer into newline-delimited
// GeoJSON (one Feature per line, WGS84) on the external volume.
//
// Every hazard source this pipeline uses is served this way, and the two
// protocols differ only in how they page, so this is one script with a
// `--kind`. It is resumable at page granularity: a completed page is written
// under its final name only after the whole page parsed, and a run that finds
// the `.done` marker refuses to redo work. A run that stops early leaves no
// `.done` marker, so a partial layer cannot be mistaken for a complete one by
// the next stage (vector_share.py refuses inputs without the marker).
//
// Usage:
//   node fetch-layer.mjs --kind arcgis --url <layer/query base> --out <dir> --name nsw-flood \
//        [--where "1=1"] [--page 1000] [--fields "A,B"] [--rangeField fid]
//   node fetch-layer.mjs --kind wfs --url <wfs endpoint> --type open-data-platform:plan_overlay \
//        --out <dir> --name vic-lsio --cql "zone_code LIKE 'LSIO%'" [--page 5000]
//
// `--rangeField <integer field>` pages by value window instead of by offset:
// page N holds `field >= min + N*page AND field < min + (N+1)*page`. ArcGIS
// resolves `resultOffset` by walking the result set, so on a multi-million-row
// layer (QLD bushfire prone area, 2.56M polygons) a page past offset ~1M takes
// longer than the proxy's 30 s budget and comes back empty, while the same
// page as an indexed range answers in ~2.5 s. A window can hold fewer rows
// than `--page` (ids have gaps) or none; it is still written, so the page index
// stays the resume point, and completeness is proven by the row total.
//
// Sources and licences: docs/feature/housing/data-sources.md.
import { mkdirSync, existsSync, writeFileSync, renameSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const UA = "shorted-housing/1.0 (+https://shorted.com.au)";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const kind = arg("kind");
const url = arg("url");
const out = arg("out");
const name = arg("name");
const pageSize = Number(arg("page", kind === "wfs" ? "5000" : "1000"));
if (!kind || !url || !out || !name) {
  console.error("need --kind arcgis|wfs --url --out --name");
  process.exit(2);
}
const dir = resolve(out, name);
mkdirSync(dir, { recursive: true });
const doneMarker = resolve(dir, ".done");
if (existsSync(doneMarker)) {
  console.log(`${name}: already complete (${doneMarker} exists)`);
  process.exit(0);
}

async function fetchJSON(target, attempt = 1) {
  const retry = async (why) => {
    const wait = 2000 * attempt;
    console.warn(`  ${why}; retry ${attempt} in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return fetchJSON(target, attempt + 1);
  };
  let res;
  let text;
  try {
    res = await fetch(target, { headers: { "User-Agent": UA, Accept: "application/json" } });
    text = await res.text();
  } catch (err) {
    // A reset connection over a thousand-page run is routine, not fatal.
    if (attempt < 5) return retry(`network error (${err.message})`);
    throw err;
  }
  if (!res.ok) {
    if (attempt < 5) return retry(`HTTP ${res.status}`);
    throw new Error(`HTTP ${res.status} for ${target}: ${text.slice(0, 200)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    // Hosted-service proxies answer a timed-out query with 200 and an empty body.
    if (attempt < 5) return retry("non-JSON response");
    throw new Error(`non-JSON response for ${target}: ${text.slice(0, 200)}`);
  }
  if (json.error) {
    // ArcGIS reports server-side failures as 200 + {error}. Some servers time
    // out on a large page; halving is handled by the caller via the thrown code.
    const e = new Error(`server error for ${target}: ${JSON.stringify(json.error).slice(0, 300)}`);
    e.arcgisError = json.error;
    throw e;
  }
  return json;
}

function writePage(index, features) {
  const tmp = resolve(dir, `page-${String(index).padStart(5, "0")}.geojsonl.tmp`);
  const final = tmp.replace(/\.tmp$/, "");
  writeFileSync(tmp, features.map((f) => JSON.stringify(f)).join("\n") + (features.length ? "\n" : ""));
  renameSync(tmp, final);
  return final;
}

function existingPages() {
  return readdirSync(dir).filter((f) => /^page-\d+\.geojsonl$/.test(f)).length;
}

function existingRows() {
  return readdirSync(dir)
    .filter((f) => /^page-\d+\.geojsonl$/.test(f))
    .reduce((n, f) => n + readFileSync(resolve(dir, f), "utf8").split("\n").filter(Boolean).length, 0);
}

async function runArcgis() {
  const where = arg("where", "1=1");
  const fields = arg("fields", "*");
  // Count first so a run can prove completeness at the end.
  const countUrl = `${url}?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`;
  const { count } = await fetchJSON(countUrl);
  console.log(`${name}: ${count} features expected`);
  if (arg("rangeField")) return runArcgisRanges(where, fields, count, arg("rangeField"));
  let offset = existingPages() * pageSize;
  let page = existingPages();
  let size = pageSize;
  let total = offset;
  while (offset < count) {
    const q = new URLSearchParams({
      where,
      outFields: fields,
      outSR: "4326",
      geometryPrecision: "6",
      returnGeometry: "true",
      resultOffset: String(offset),
      resultRecordCount: String(size),
      orderByFields: arg("orderBy", ""),
      f: "geojson",
    });
    if (!q.get("orderByFields")) q.delete("orderByFields");
    // e.g. --extra "maxAllowableOffset=0.0001" — server-side generalisation for
    // parcel-precision layers whose full geometry is 130 MB a page.
    for (const [k, v] of new URLSearchParams(arg("extra", ""))) q.set(k, v);
    let json;
    try {
      json = await fetchJSON(`${url}?${q}`);
    } catch (err) {
      if (err.arcgisError && size > 100) {
        size = Math.floor(size / 2);
        console.warn(`  page too heavy; retrying with ${size}`);
        continue;
      }
      throw err;
    }
    const feats = json.features ?? [];
    if (!feats.length) throw new Error(`${name}: empty page at offset ${offset} before reaching ${count}`);
    // Only whole-page-size pages keep the page/offset arithmetic resumable.
    if (size !== pageSize) {
      // Sub-page: append into a numbered sub-file; still atomic per write.
      writePage(`${page}-${offset}`, feats);
    } else {
      writePage(page, feats);
      page += 1;
    }
    offset += feats.length;
    total += feats.length;
    process.stdout.write(`  ${total}/${count}\r`);
    if (size !== pageSize && offset % pageSize === 0) { size = pageSize; page += 1; }
  }
  console.log(`\n${name}: fetched ${total}`);
  if (total < count) throw new Error(`${name}: fetched ${total} of ${count}`);
  writeFileSync(doneMarker, JSON.stringify({ count, fetchedAt: new Date().toISOString(), url, where }) + "\n");
}

function queryParams(where, fields) {
  const q = new URLSearchParams({
    where, outFields: fields, outSR: "4326", geometryPrecision: "6", returnGeometry: "true", f: "geojson",
  });
  for (const [k, v] of new URLSearchParams(arg("extra", ""))) q.set(k, v);
  return q;
}

async function runArcgisRanges(where, fields, count, field) {
  const stats = JSON.stringify(["min", "max"].map((t) => ({ statisticType: t, onStatisticField: field, outStatisticFieldName: t })));
  const statsUrl = `${url}?where=${encodeURIComponent(where)}&outStatistics=${encodeURIComponent(stats)}&f=json`;
  const { min, max } = (await fetchJSON(statsUrl)).features[0].attributes;
  if (!Number.isInteger(min) || !Number.isInteger(max)) throw new Error(`${name}: ${field} is not an integer range (${min}..${max})`);
  let page = existingPages();
  let total = existingRows();
  for (let lo = min + page * pageSize; lo <= max; lo += pageSize, page += 1) {
    const window = `(${where}) AND ${field} >= ${lo} AND ${field} < ${lo + pageSize}`;
    const json = await fetchJSON(`${url}?${queryParams(window, fields)}`);
    if (json.exceededTransferLimit) throw new Error(`${name}: window ${lo} exceeded the server's transfer limit; lower --page`);
    const feats = json.features ?? [];
    writePage(page, feats);
    total += feats.length;
    process.stdout.write(`  ${total}/${count} (window ${lo})\r`);
  }
  console.log(`\n${name}: fetched ${total}`);
  if (total !== count) throw new Error(`${name}: fetched ${total} of ${count}`);
  writeFileSync(doneMarker, JSON.stringify({ count, fetchedAt: new Date().toISOString(), url, where, rangeField: field }) + "\n");
}

async function runWfs() {
  const typeName = arg("type");
  const cql = arg("cql", "");
  if (!typeName) throw new Error("wfs needs --type");
  const base = new URLSearchParams({
    service: "WFS", version: "2.0.0", request: "GetFeature", typeName,
    outputFormat: "application/json", srsName: "EPSG:4326",
  });
  if (cql) base.set("cql_filter", cql);
  const hits = await fetch(`${url}?${new URLSearchParams({ ...Object.fromEntries(base), resultType: "hits" })}`, {
    headers: { "User-Agent": UA },
  }).then((r) => r.text());
  const count = Number((hits.match(/numberMatched="(\d+)"/) ?? [])[1] ?? NaN);
  if (!Number.isFinite(count)) throw new Error(`${name}: could not read numberMatched from hits response`);
  console.log(`${name}: ${count} features expected`);
  let page = existingPages();
  let start = page * pageSize;
  let total = start;
  while (start < count) {
    const q = new URLSearchParams(base);
    q.set("count", String(pageSize));
    q.set("startIndex", String(start));
    q.set("sortBy", arg("sortBy", "pfi"));
    const json = await fetchJSON(`${url}?${q}`);
    const feats = json.features ?? [];
    if (!feats.length) throw new Error(`${name}: empty page at startIndex ${start} before reaching ${count}`);
    writePage(page, feats);
    page += 1;
    start += feats.length;
    total += feats.length;
    process.stdout.write(`  ${total}/${count}\r`);
  }
  console.log(`\n${name}: fetched ${total}`);
  if (total < count) throw new Error(`${name}: fetched ${total} of ${count}`);
  writeFileSync(doneMarker, JSON.stringify({ count, fetchedAt: new Date().toISOString(), url, typeName, cql }) + "\n");
}

(kind === "arcgis" ? runArcgis() : runWfs()).catch((err) => {
  console.error(`${name}: FAILED — ${err.message}`);
  process.exit(1);
});
