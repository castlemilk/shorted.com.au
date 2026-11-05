#!/usr/bin/env node
// snapshot-cutover-check.mjs: records what the stock picker serves, and diffs two
// recordings, around the STRATEGY_SOURCE cutover (views -> snapshot, PR-11b).
//
// Read only. It calls the public StrategyService reads over Connect's JSON
// protocol and writes a JSON file. It never writes to any database.
//
//   node scripts/strategies/snapshot-cutover-check.mjs record \
//       --base-url https://api.shorted.com.au --out before.json
//   node scripts/strategies/snapshot-cutover-check.mjs diff before.json after.json
//
// `diff` exits 0 when every difference is one the cutover allows, and 1 otherwise.
//
// The allowed differences (the PR-11 live check):
//   - crowded-short-breakout: a code whose days_to_cover changed. Its 20-bar
//     window gained session D's bar, so its days-to-cover and score may move.
//   - zanger-breakout, canslim, quality-compounders: a code whose fundamentals
//     digest changed since the snapshot was written. Its figures moved.
// Everything else must match: every strategy's status per code and status
// counts, Minervini's top ten, and GetStockStrategyFit for BHP.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const STRATEGY_IDS = [
  "zanger-breakout",
  "canslim",
  "minervini-trend-template",
  "crowded-short-breakout",
  "quality-compounders",
];

// The strategies whose rules read fundamentals (spec: fundamentalsStrategies).
export const FUNDAMENTALS_STRATEGIES = new Set(["zanger-breakout", "canslim", "quality-compounders"]);

export const DAYS_TO_COVER_STRATEGY = "crowded-short-breakout";
export const MINERVINI_TOP = 10;
export const FIT_CODE = "BHP";
const PICK_LIMIT = 100;

const SERVICE = "shorts.v1alpha1.StrategyService";

async function callJSON(baseUrl, method, body, fetchImpl = fetch) {
  const url = `${baseUrl.replace(/\/+$/, "")}/${SERVICE}/${method}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "connect-protocol-version": "1", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

// digest is a stable hash of a pick's fundamentals object, so a change in any
// figure, basis or provenance field the wire carries shows as a new digest.
export function fundamentalsDigest(fundamentals) {
  if (!fundamentals) return null;
  return createHash("sha256").update(stableStringify(fundamentals)).digest("hex").slice(0, 16);
}

export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

// summarisePicks reduces one GetStrategyPicks response to what the check compares.
export function summarisePicks(resp) {
  const statuses = {};
  for (const p of resp.picks ?? []) {
    statuses[p.stockCode] = {
      status: p.status ?? "",
      score: round(p.score),
      rank: p.rank ?? 0,
      daysToCover: p.hasDaysToCover ? round(p.daysToCover) : null,
      digest: fundamentalsDigest(p.fundamentals),
    };
  }
  return {
    sessionDate: resp.sessionDate ?? "",
    shortReportDate: resp.shortReportDate ?? "",
    stale: Boolean(resp.stale),
    statusCounts: {
      triggered: resp.statusCounts?.triggered ?? 0,
      setup: resp.statusCounts?.setup ?? 0,
      watch: resp.statusCounts?.watch ?? 0,
    },
    statuses,
    top: (resp.picks ?? []).slice(0, MINERVINI_TOP).map((p) => ({ rank: p.rank ?? 0, stockCode: p.stockCode, status: p.status ?? "" })),
  };
}

function round(v) {
  return typeof v === "number" ? Math.round(v * 1e6) / 1e6 : null;
}

// record reads every strategy's picks and BHP's fit, and returns the recording.
export async function record(baseUrl, { now = new Date(), fetchImpl = fetch } = {}) {
  const out = { recordedAt: now.toISOString(), baseUrl, strategies: {}, fit: null };
  for (const id of STRATEGY_IDS) {
    const resp = await callJSON(baseUrl, "GetStrategyPicks", { strategyId: id, limit: PICK_LIMIT }, fetchImpl);
    out.strategies[id] = summarisePicks(resp);
  }
  const fit = await callJSON(baseUrl, "GetStockStrategyFit", { stockCode: FIT_CODE }, fetchImpl);
  out.fit = {
    sessionDate: fit.sessionDate ?? "",
    stale: Boolean(fit.stale),
    inUniverse: Boolean(fit.inUniverse),
    fits: Object.fromEntries((fit.fits ?? []).map((f) => [f.strategyId, { status: f.status ?? "", score: round(f.score), rank: f.rank ?? 0 }])),
  };
  return out;
}

// diff compares two recordings. before is the views' recording, after the snapshot's.
// It returns { identical, allowed: [...], unexpected: [...], info: [...] }.
export function diff(before, after) {
  const allowed = [];
  const unexpected = [];
  const info = [];

  for (const id of STRATEGY_IDS) {
    const b = before.strategies?.[id];
    const a = after.strategies?.[id];
    if (!b || !a) {
      unexpected.push(`${id}: missing from one recording`);
      continue;
    }
    if (b.sessionDate !== a.sessionDate) info.push(`${id}: session_date ${b.sessionDate} -> ${a.sessionDate}`);
    if (b.shortReportDate !== a.shortReportDate) info.push(`${id}: short_report_date ${b.shortReportDate} -> ${a.shortReportDate}`);
    if (JSON.stringify(b.statusCounts) !== JSON.stringify(a.statusCounts)) {
      unexpected.push(`${id}: status_counts ${JSON.stringify(b.statusCounts)} -> ${JSON.stringify(a.statusCounts)}`);
    }

    const codes = new Set([...Object.keys(b.statuses), ...Object.keys(a.statuses)]);
    for (const code of [...codes].sort()) {
      const x = b.statuses[code];
      const y = a.statuses[code];
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      const label = `${id} ${code}: ${JSON.stringify(x ?? null)} -> ${JSON.stringify(y ?? null)}`;
      if (id === DAYS_TO_COVER_STRATEGY && x && y && x.daysToCover !== y.daysToCover) {
        allowed.push(`${label} [days_to_cover window gained session D's bar]`);
        continue;
      }
      if (FUNDAMENTALS_STRATEGIES.has(id) && x && y && x.digest !== y.digest) {
        allowed.push(`${label} [fundamentals digest changed since the snapshot]`);
        continue;
      }
      unexpected.push(label);
    }

    const topB = JSON.stringify(b.top);
    const topA = JSON.stringify(a.top);
    if (id === "minervini-trend-template" && topB !== topA) {
      unexpected.push(`${id}: top ${MINERVINI_TOP} changed: ${topB} -> ${topA}`);
    }
  }

  if (JSON.stringify(before.fit?.fits ?? {}) !== JSON.stringify(after.fit?.fits ?? {})) {
    unexpected.push(`${FIT_CODE} fit changed: ${JSON.stringify(before.fit?.fits)} -> ${JSON.stringify(after.fit?.fits)}`);
  }
  if (before.fit?.sessionDate !== after.fit?.sessionDate) {
    info.push(`${FIT_CODE} fit session_date ${before.fit?.sessionDate} -> ${after.fit?.sessionDate}`);
  }
  return { identical: unexpected.length === 0 && allowed.length === 0, allowed, unexpected, info };
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      flags[rest[i].slice(2)] = rest[i + 1];
      i++;
    } else {
      positional.push(rest[i]);
    }
  }
  return { cmd, flags, positional };
}

function usage() {
  return "usage: snapshot-cutover-check.mjs record --base-url <url> --out <file> | diff <before.json> <after.json>";
}

async function main(argv) {
  const { cmd, flags, positional } = parseArgs(argv);
  if (cmd === "record") {
    if (!flags["base-url"] || !flags.out) throw new Error(usage());
    const rec = await record(flags["base-url"]);
    await writeFile(flags.out, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`recorded ${Object.keys(rec.strategies).length} strategies and ${FIT_CODE} to ${flags.out}`);
    return 0;
  }
  if (cmd === "diff") {
    if (positional.length !== 2) throw new Error(usage());
    const [before, after] = await Promise.all(positional.map(async (p) => JSON.parse(await readFile(p, "utf8"))));
    const result = diff(before, after);
    for (const line of result.info) console.log(`info: ${line}`);
    for (const line of result.allowed) console.log(`allowed: ${line}`);
    for (const line of result.unexpected) console.log(`UNEXPECTED: ${line}`);
    console.log(result.unexpected.length === 0 ? "cutover check: no unexpected differences" : `cutover check: ${result.unexpected.length} unexpected difference(s)`);
    return result.unexpected.length === 0 ? 0 : 1;
  }
  throw new Error(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(2);
    },
  );
}
