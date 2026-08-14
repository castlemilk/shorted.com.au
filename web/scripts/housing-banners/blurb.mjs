#!/usr/bin/env node
// Suburb banner editorial pipeline: for each suburb missing a banner_blurb,
// gather demographic/geo facts from the DB, ask the local `agy` agentic CLI
// for a short evocative blurb + landmark list + archetype hint + image scene
// phrase (strict JSON), and upsert the result onto suburb_demographics.
//
// Usage:
//   node web/scripts/housing-banners/blurb.mjs --dry --sal 10463
//   node web/scripts/housing-banners/blurb.mjs --limit 25 --priced-only
//   node web/scripts/housing-banners/blurb.mjs --sal 10463
//
// Flags:
//   --dry           Parse + print the agy JSON only. NEVER writes to the DB.
//   --sal <code>    Target a single SAL code.
//   --limit <n>     Cap how many suburbs are processed in one run (default 10).
//   --priced-only   Only consider suburbs that have a house_price_regions row.
//
// Resumable: real (non-dry) mode only selects suburbs where banner_blurb IS
// NULL, so re-running after a partial batch just picks up where it left off.

import { execFileSync } from "node:child_process";
import { ARCHETYPE_BASE } from "../geo/classify-archetype.mjs";

// The 10 archetype ids the LLM may choose from: the 6 deterministically
// derivable ones (ARCHETYPE_BASE) + 4 that only agy's world knowledge can
// supply (harbour / river-valley / hills-ranges / farmland). See
// web/scripts/geo/classify-archetype.mjs and the suburb-banners spec §5.
const ARCHETYPE_LLM_ONLY = ["harbour", "river-valley", "hills-ranges", "farmland"];
export const VALID_ARCHETYPES = [...ARCHETYPE_BASE, ...ARCHETYPE_LLM_ONLY];

const DEFAULT_DATABASE_URL = "postgresql://admin:password@localhost:5438/shorts";

// Known-suburb fixtures for --dry runs against an empty local DB (see task
// spec: local suburb_demographics is empty, so --dry --sal <code> falls back
// to a small built-in facts table for demo SALs). ONLY used in --dry mode —
// real (non-dry) runs always read facts from the DB.
const DRY_FIXTURES = {
  "10463": {
    salCode: "10463",
    name: "Bondi Beach",
    state: "NSW",
    lga: "Waverley",
    coastKm: 0.4,
    parks: 3,
    language: "English",
    median: "$3.28M",
  },
};

function parseArgs(argv) {
  const args = { dry: false, sal: null, limit: 10, pricedOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") args.dry = true;
    else if (a === "--sal") args.sal = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--priced-only") args.pricedOnly = true;
    else if (a.startsWith("--sal=")) args.sal = a.slice("--sal=".length);
    else if (a.startsWith("--limit=")) args.limit = Number(a.slice("--limit=".length));
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = 10;
  return args;
}

/**
 * Build the strict-JSON instruction prompt for one suburb's facts.
 * @param {{name:string,state:string,lga:string,coastKm:number|null,parks:number|null,language:string,median:string}} facts
 */
export function buildPrompt(facts) {
  const {
    name,
    state,
    lga,
    coastKm,
    parks,
    language,
    median = "price not tracked",
  } = facts;
  const coastLine =
    coastKm === null || coastKm === undefined
      ? "distance to coast: unknown"
      : `distance to coast: ${coastKm} km`;
  const parksLine =
    parks === null || parks === undefined ? "parks: unknown" : `parks nearby: ${parks}`;

  return `You are a local-area editorial researcher writing a short suburb banner blurb for an Australian real-estate/short-selling data site.

Suburb: ${name}, ${state}
Local Government Area: ${lga || "unknown"}
${coastLine}
${parksLine}
Predominant home language: ${language || "unknown"}
Median house price: ${median}

Respond with STRICT JSON ONLY — no prose before or after, no markdown code fences, just the raw JSON object — matching exactly this shape:
{"blurb": "<=30 words, evocative but factual, no clichés or marketing-speak", "landmarks": [{"name": "", "kind": "beach|park|landmark|river|mountain|building"}], "archetype_hint": "one of: ${VALID_ARCHETYPES.join(", ")}", "image_prompt": "short scene phrase"}

Rules:
- The blurb must be 30 words or fewer, grounded in real, verifiable facts about this specific suburb. Do not use marketing clichés ("hidden gem", "vibrant community", "best-kept secret").
- Only name landmarks if you are confident they are real and located in THIS specific suburb (not a nearby suburb or the broader region). If you are not confident, or this is an obscure suburb you don't have specific knowledge of, return an empty landmarks array and lean on nature/geography facts instead (coastline, parks, terrain).
- archetype_hint must be exactly one of the ${VALID_ARCHETYPES.length} listed ids.
- image_prompt is a short phrase describing a representative scene for this suburb (for background art generation), not a sentence.
- Output raw JSON only. No prose outside the JSON object.`;
}

/**
 * Extract the first balanced {...} JSON object from arbitrary text output
 * (agy is an agentic tool and may wrap its answer in prose/markdown).
 * @param {string} text
 */
export function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error(`agy: no JSON object found in output:\n${text}`);
  }
  // Find the matching closing brace for the first '{', respecting string
  // literals so braces inside strings don't confuse the depth count.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (err) {
          throw new Error(
            `agy: found a JSON-looking block but it failed to parse: ${err.message}\n${candidate}`,
          );
        }
      }
    }
  }
  throw new Error(`agy: unbalanced braces in output, no matching '}' found:\n${text}`);
}

/**
 * Run a single non-interactive agy prompt and return the parsed JSON object.
 * @param {string} prompt
 */
export function runAgy(prompt) {
  let raw;
  try {
    raw = execFileSync("agy", ["-p", prompt], {
      encoding: "utf8",
      maxBuffer: 8 << 20,
    });
  } catch (err) {
    const stderr = err?.stderr ? err.stderr.toString() : "";
    const stdout = err?.stdout ? err.stdout.toString() : "";
    throw new Error(
      `agy invocation failed (exit ${err?.status ?? "?"}): ${err?.message ?? err}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (!raw || !raw.trim()) {
    throw new Error("agy: empty output, no JSON to parse");
  }
  return extractJson(raw);
}

// --- DB access: prefer `pg` (present in web/node_modules); fall back to
// shelling out to `psql` if `pg` can't be resolved. Never adds a dependency.

async function tryLoadPg() {
  try {
    const mod = await import("pg");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function databaseUrl() {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

// ASCII unit separator — used as the psql column delimiter so rows can be
// split back into columns safely (suburb text/JSON values won't contain it).
const PSQL_FIELD_SEP = "\x1f";

/** Minimal DB facade: query(text, params) -> { rows }. Rows are arrays of
 * column strings (psql has no typed result set); '' means SQL NULL. */
function makePsqlDb() {
  const url = databaseUrl();
  return {
    kind: "psql",
    async query(text, params = []) {
      // psql doesn't support $1-style bound params directly; substitute
      // literals ourselves (values here are script-controlled: strings,
      // numbers, null, or JSON strings we already built) using PostgreSQL
      // dollar-quoting for text/JSON to sidestep escaping issues.
      let sql = text;
      params.forEach((val, idx) => {
        const token = `$${idx + 1}`;
        let literal;
        if (val === null || val === undefined) {
          literal = "NULL";
        } else if (typeof val === "number") {
          literal = String(val);
        } else {
          const tag = `sbtag${idx}`;
          literal = `$${tag}$${String(val)}$${tag}$`;
        }
        sql = sql.split(token).join(literal);
      });
      const out = execFileSync(
        "psql",
        [url, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", PSQL_FIELD_SEP, "-c", sql],
        { encoding: "utf8", maxBuffer: 16 << 20 },
      );
      const rows = out
        .split("\n")
        .map((l) => l.replace(/\r$/, ""))
        .filter((l) => l.length > 0)
        .map((line) => line.split(PSQL_FIELD_SEP));
      return { rows };
    },
  };
}

async function makeDb() {
  const pg = await tryLoadPg();
  if (pg) {
    const pool = new pg.Pool({ connectionString: databaseUrl() });
    return {
      kind: "pg",
      async query(text, params = []) {
        return pool.query(text, params);
      },
      async end() {
        await pool.end();
      },
    };
  }
  return makePsqlDb();
}

const FACTS_SQL = `
  SELECT d.sal_code, d.sal_name, d.state_code,
         lg.lga_name,
         a.dist_to_coast_km,
         a.parks_count,
         d.top_language,
         (SELECT hp.value
            FROM house_prices hp
            JOIN house_price_regions r ON r.region_code = hp.region_code
           WHERE r.sal_code = d.sal_code AND r.region_type = 'suburb'
             AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
           ORDER BY hp.period DESC LIMIT 1) AS median_price
    FROM suburb_demographics d
    LEFT JOIN suburb_lga sl ON sl.sal_code = d.sal_code
    LEFT JOIN lga lg ON lg.lga_code24 = sl.lga_code24
    LEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code
   WHERE d.sal_code = $1
   LIMIT 1`;

function candidatesSql({ pricedOnly, limit, sal }) {
  const clauses = ["d.banner_blurb IS NULL"];
  if (sal) clauses.push(`d.sal_code = '${sal.replace(/'/g, "''")}'`);
  if (pricedOnly) {
    clauses.push(
      `EXISTS (SELECT 1 FROM house_price_regions r WHERE r.sal_code = d.sal_code AND r.region_type = 'suburb')`,
    );
  }
  return `SELECT d.sal_code FROM suburb_demographics d WHERE ${clauses.join(" AND ")} ORDER BY d.sal_code LIMIT ${Number(limit)}`;
}

function moneyFmt(value) {
  if (value === null || value === undefined) return "price not tracked";
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "price not tracked";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

/** Normalise a raw facts row (pg object row OR psql string-array row) into
 * the canonical facts shape used by buildPrompt. */
function normaliseFactsRow(row, dbKind) {
  let salCode, name, state, lga, coastKm, parks, language, medianRaw;
  if (dbKind === "pg") {
    salCode = row.sal_code;
    name = row.sal_name;
    state = row.state_code;
    lga = row.lga_name;
    coastKm = row.dist_to_coast_km !== null ? Number(row.dist_to_coast_km) : null;
    parks = row.parks_count !== null ? Number(row.parks_count) : null;
    language = row.top_language;
    medianRaw = row.median_price;
  } else {
    // psql row is an array of strings in SELECT order; empty string == NULL
    const [sc, sn, st, lgaName, coast, parksCount, lang, median] = row;
    salCode = sc;
    name = sn;
    state = st;
    lga = lgaName || null;
    coastKm = coast !== "" && coast !== undefined ? Number(coast) : null;
    parks = parksCount !== "" && parksCount !== undefined ? Number(parksCount) : null;
    language = lang || null;
    medianRaw = median !== "" && median !== undefined ? median : null;
  }
  return {
    salCode,
    name,
    state,
    lga: lga || "unknown",
    coastKm,
    parks,
    language: language || "unknown",
    median: moneyFmt(medianRaw),
  };
}

async function fetchFacts(db, salCode) {
  const res = await db.query(FACTS_SQL, [salCode]);
  const rows = res.rows;
  if (!rows || rows.length === 0) return null;
  return normaliseFactsRow(rows[0], db.kind);
}

const UPDATE_SQL = `
  UPDATE suburb_demographics
     SET banner_blurb = $2,
         banner_landmarks = $3::jsonb,
         banner_archetype = COALESCE($4, banner_archetype),
         banner_bg_key = COALESCE($4, banner_bg_key),
         banner_generated_at = now()
   WHERE sal_code = $1`;

async function writeBanner(db, salCode, result) {
  const hint = VALID_ARCHETYPES.includes(result.archetype_hint) ? result.archetype_hint : null;
  const landmarksJson = JSON.stringify(result.landmarks ?? []);
  await db.query(UPDATE_SQL, [salCode, result.blurb, landmarksJson, hint]);
  return hint;
}

function validateResult(result) {
  const missing = ["blurb", "landmarks", "archetype_hint", "image_prompt"].filter(
    (k) => !(k in result),
  );
  if (missing.length) {
    throw new Error(`agy JSON missing required keys: ${missing.join(", ")}\n${JSON.stringify(result)}`);
  }
  if (!Array.isArray(result.landmarks)) {
    throw new Error(`agy JSON "landmarks" must be an array, got: ${JSON.stringify(result.landmarks)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dry) {
    let facts;
    if (args.sal && DRY_FIXTURES[args.sal]) {
      facts = DRY_FIXTURES[args.sal];
      console.log(`[dry] using built-in fixture for SAL ${args.sal} (${facts.name}) — DB not queried`);
    } else if (args.sal) {
      const db = await makeDb();
      console.log(`[dry] db mechanism: ${db.kind}`);
      facts = await fetchFacts(db, args.sal);
      if (db.end) await db.end();
      if (!facts) {
        console.log(
          `[dry] no DB row for SAL ${args.sal} and no built-in fixture — add one to DRY_FIXTURES or pass --sal 10463`,
        );
        process.exit(1);
      }
    } else {
      facts = DRY_FIXTURES["10463"];
      console.log(`[dry] no --sal given, defaulting to fixture SAL 10463 (${facts.name})`);
    }

    const prompt = buildPrompt(facts);
    console.log(`[dry] prompt:\n${prompt}\n`);
    const t0 = Date.now();
    const result = runAgy(prompt);
    const ms = Date.now() - t0;
    validateResult(result);
    console.log(`[dry] agy responded in ${ms}ms`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Real mode: always reads from the DB, never uses DRY_FIXTURES.
  const db = await makeDb();
  console.log(`db mechanism: ${db.kind}`);
  const sql = candidatesSql(args);
  const res = await db.query(sql, []);
  const salCodes = res.rows.map((r) => (db.kind === "pg" ? r.sal_code : r[0]));
  console.log(`found ${salCodes.length} candidate suburb(s) to process`);

  let ok = 0;
  let failed = 0;
  for (const salCode of salCodes) {
    try {
      const facts = await fetchFacts(db, salCode);
      if (!facts) {
        console.warn(`skip ${salCode}: no facts row found`);
        continue;
      }
      console.log(`generating banner for ${salCode} (${facts.name}, ${facts.state})...`);
      const prompt = buildPrompt(facts);
      const t0 = Date.now();
      const result = runAgy(prompt);
      const ms = Date.now() - t0;
      validateResult(result);
      const hintUsed = await writeBanner(db, salCode, result);
      ok++;
      console.log(
        `  done in ${ms}ms — archetype_hint=${result.archetype_hint}${hintUsed ? "" : " (invalid, kept existing archetype)"}, landmarks=${(result.landmarks ?? []).length}`,
      );
    } catch (err) {
      failed++;
      console.error(`  FAILED ${salCode}: ${err.message}`);
    }
  }

  console.log(`done: ${ok} written, ${failed} failed, ${salCodes.length} candidates`);
  if (db.end) await db.end();
  if (failed > 0 && ok === 0) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
