#!/usr/bin/env node
// snapshot-cutover-check.mjs: records what the stock picker serves, and diffs two
// recordings, around the STRATEGY_SOURCE cutover (views -> snapshot, PR-11b).
//
// Read only. It calls the StrategyService reads over Connect's JSON protocol and
// writes a JSON file. It never writes to any database, and it never writes the
// bearer token into the recording.
//
//   node scripts/strategies/snapshot-cutover-check.mjs record \
//       --base-url https://api.shorted.com.au --out before.json [--token-env SHORTED_API_TOKEN]
//   node scripts/strategies/snapshot-cutover-check.mjs diff before.json after.json
//
// Every strategy is read in full, page by page, from the anonymous GetStrategyPicks.
// The public depth clamp refuses an offset once it is on, so a recording taken
// while it is on needs a bearer token (--token-env names the variable): then the
// private GetViewerStrategyPicks reads every row. A clamped or short read fails
// the recording (exit 2) rather than comparing a part of the list.
//
// `diff` exits 0 when every difference is one the cutover allows, 1 when one is
// not, and 2 on a usage error. Both recordings must answer for the same session,
// and the after recording must be the snapshot's own session (GetStrategyDataStatus
// names it), so a views fallback cannot pass as a cutover.
//
// Every status must be identical for every code, for all five strategies. The
// allowed differences (the PR-11 live check) are the only ones a diff accepts:
//   - crowded-short-breakout: a code whose days_to_cover changed (its 20-bar window
//     gained session D's bar). Its score and rank may move with it; its status may not.
//   - zanger-breakout, canslim, quality-compounders: a code whose fundamentals digest
//     changed since the snapshot was written. Its figures moved, so it is excluded.
// Pick ranks are not compared: they follow from status and score. BHP's fit is compared
// by status and score, and its rank only when a code of that strategy was allowed to move.

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
export const PAGE_SIZE = 100;

const SERVICE = "shorts.v1alpha1.StrategyService";
const MAX_RETRIES = 4;

// sleep is injected so the tests do not wait.
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RecordError extends Error {}

// callJSON posts one Connect unary call. A 429 waits for Retry-After (or a doubling
// backoff) and retries, so a paced recording survives the edge's per-IP buckets.
export async function callJSON(baseUrl, method, body, opts = {}) {
  const { fetchImpl = fetch, token = "", sleep = defaultSleep, baseDelayMs = 2000 } = opts;
  const url = `${baseUrl.replace(/\/+$/, "")}/${SERVICE}/${method}`;
  const headers = { "content-type": "application/json", "connect-protocol-version": "1", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers?.get?.("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      // Never echo the token; the body is the server's own error text.
      throw new RecordError(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  }
}

// digest is a stable hash of a pick's fundamentals object, so a change in any
// figure, basis or provenance field shows as a new digest. Provenance timestamps
// (fetched_at) are left out: a re-fetch of identical figures is not a change.
export function fundamentalsDigest(fundamentals) {
  if (!fundamentals) return null;
  return createHash("sha256").update(stableStringify(withoutProvenance(fundamentals))).digest("hex").slice(0, 16);
}

function withoutProvenance(v) {
  if (Array.isArray(v)) return v.map(withoutProvenance);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) {
      if (/^fetched[_]?at$/i.test(k)) continue;
      out[k] = withoutProvenance(v[k]);
    }
    return out;
  }
  return v;
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

// summarisePicks reduces one page of GetStrategyPicks to what the check compares.
// A page is merged into the summary by collectStrategy, so this takes a whole list.
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
    totalCount: resp.totalCount ?? 0,
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

// collectStrategy reads one strategy's whole list, page by page. It fails when a
// page is clamped, refused, or ends before totalCount rows were read.
export async function collectStrategy(baseUrl, strategyId, opts = {}) {
  const method = opts.token ? "GetViewerStrategyPicks" : "GetStrategyPicks";
  const pages = [];
  let total = null;
  let seen = 0;
  // The next page starts after the rows already read, so a server that caps a page below PAGE_SIZE cannot skip rows.
  while (total === null || seen < total) {
    const offset = seen;
    const resp = await callJSON(baseUrl, method, { strategyId, limit: PAGE_SIZE, offset }, opts);
    if (resp.viewer?.clamped) {
      throw new RecordError(`${strategyId}: the read is clamped at ${resp.viewer.limit} rows (${resp.viewer.access}); pass --token-env to read the full list`);
    }
    if (total === null) total = resp.totalCount ?? 0;
    const page = resp.picks ?? [];
    if (page.length === 0 && offset < total) {
      throw new RecordError(`${strategyId}: page at offset ${offset} is empty but totalCount is ${total}`);
    }
    seen += page.length;
    pages.push(resp);
  }
  if (seen !== total) throw new RecordError(`${strategyId}: read ${seen} of ${total} rows`);
  const merged = { ...pages[0], picks: pages.flatMap((p) => p.picks ?? []) };
  return summarisePicks(merged);
}

// record reads every strategy's whole list, BHP's fit and the source dates, and returns the recording.
export async function record(baseUrl, { now = new Date(), fetchImpl = fetch, token = "", sleep = defaultSleep, delayMs = 0 } = {}) {
  const opts = { fetchImpl, token, sleep };
  const pause = async () => {
    if (delayMs > 0) await sleep(delayMs);
  };
  const out = { recordedAt: now.toISOString(), baseUrl, authenticated: Boolean(token), strategies: {}, fit: null, dataStatus: null };
  const status = await callJSON(baseUrl, "GetStrategyDataStatus", {}, opts);
  out.dataStatus = { latestSession: status.latestSession ?? "", snapshotAsOf: status.snapshotAsOf ?? "", snapshotCompletedAt: status.snapshotCompletedAt ?? "" };
  for (const id of STRATEGY_IDS) {
    await pause();
    out.strategies[id] = await collectStrategy(baseUrl, id, opts);
  }
  await pause();
  const fit = await callJSON(baseUrl, "GetStockStrategyFit", { stockCode: FIT_CODE }, opts);
  out.fit = {
    sessionDate: fit.sessionDate ?? "",
    stale: Boolean(fit.stale),
    inUniverse: Boolean(fit.inUniverse),
    fits: Object.fromEntries((fit.fits ?? []).map((f) => [f.strategyId, { status: f.status ?? "", score: round(f.score), rank: f.rank ?? 0 }])),
  };
  return out;
}

// diff compares two recordings. before is the views' recording, after the snapshot's.
// It returns { identical, allowed, unexpected, info }.
export function diff(before, after) {
  const allowed = [];
  const unexpected = [];
  const info = [];
  // allowedCodes: per strategy, the codes whose change the cutover allows (for the fit's rank rule).
  const allowedCodes = {};

  if (!after.dataStatus) {
    unexpected.push("after recording has no GetStrategyDataStatus: it cannot show which session the snapshot served");
  }

  for (const id of STRATEGY_IDS) {
    const b = before.strategies?.[id];
    const a = after.strategies?.[id];
    allowedCodes[id] = new Set();
    if (!b || !a) {
      unexpected.push(`${id}: missing from one recording`);
      continue;
    }
    if (b.sessionDate !== a.sessionDate) {
      unexpected.push(`${id}: session_date ${b.sessionDate} -> ${a.sessionDate} (the recordings must be the same session)`);
    }
    if (after.dataStatus && a.sessionDate !== after.dataStatus.snapshotAsOf) {
      unexpected.push(`${id}: after session_date ${a.sessionDate} is not the snapshot's ${after.dataStatus.snapshotAsOf}`);
    }
    if (b.shortReportDate !== a.shortReportDate) {
      unexpected.push(`${id}: short_report_date ${b.shortReportDate} -> ${a.shortReportDate}`);
    }
    if (JSON.stringify(b.statusCounts) !== JSON.stringify(a.statusCounts)) {
      unexpected.push(`${id}: status_counts ${JSON.stringify(b.statusCounts)} -> ${JSON.stringify(a.statusCounts)}`);
    }
    if (b.totalCount !== a.totalCount) {
      unexpected.push(`${id}: total_count ${b.totalCount} -> ${a.totalCount}`);
    }

    const codes = new Set([...Object.keys(b.statuses), ...Object.keys(a.statuses)]);
    for (const code of [...codes].sort()) {
      const x = b.statuses[code];
      const y = a.statuses[code];
      if (!x || !y) {
        unexpected.push(`${id} ${code}: ${x ? "left" : "entered"} the list (${JSON.stringify(x ?? null)} -> ${JSON.stringify(y ?? null)})`);
        continue;
      }
      const label = `${id} ${code}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`;
      const dtcMoved = id === DAYS_TO_COVER_STRATEGY && x.daysToCover !== y.daysToCover;
      const digestMoved = FUNDAMENTALS_STRATEGIES.has(id) && x.digest !== y.digest;
      if (x.status !== y.status) {
        // A status never moves for a crowded-short code on days to cover alone.
        if (digestMoved) {
          allowed.push(`${label} [fundamentals digest changed since the snapshot]`);
          allowedCodes[id].add(code);
        } else {
          unexpected.push(label);
        }
        continue;
      }
      if (x.score !== y.score) {
        if (dtcMoved) {
          allowed.push(`${label} [days_to_cover window gained session D's bar]`);
          allowedCodes[id].add(code);
        } else if (digestMoved) {
          allowed.push(`${label} [fundamentals digest changed since the snapshot]`);
          allowedCodes[id].add(code);
        } else {
          unexpected.push(label);
        }
        continue;
      }
      if (dtcMoved || digestMoved) {
        allowed.push(`${label} [${dtcMoved ? "days_to_cover" : "fundamentals digest"} moved; status and score unchanged]`);
        allowedCodes[id].add(code);
      }
    }

    if (id === "minervini-trend-template" && JSON.stringify(b.top) !== JSON.stringify(a.top)) {
      unexpected.push(`${id}: top ${MINERVINI_TOP} changed: ${JSON.stringify(b.top)} -> ${JSON.stringify(a.top)}`);
    }
  }

  const bf = before.fit?.fits ?? {};
  const af = after.fit?.fits ?? {};
  for (const id of new Set([...Object.keys(bf), ...Object.keys(af)])) {
    const x = bf[id];
    const y = af[id];
    if (!x || !y) {
      unexpected.push(`${FIT_CODE} fit for ${id} present in only one recording`);
      continue;
    }
    const label = `${FIT_CODE} fit ${id}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`;
    const bhpAllowed = allowedCodes[id]?.has(FIT_CODE) ?? false;
    if (x.status !== y.status || x.score !== y.score) {
      if (bhpAllowed) allowed.push(`${label} [BHP's own inputs moved]`);
      else unexpected.push(label);
      continue;
    }
    if (x.rank !== y.rank) {
      // A rank follows from the other codes' scores: it may move only when one of them was allowed to.
      if ((allowedCodes[id]?.size ?? 0) > 0) allowed.push(`${label} [rank follows an allowed move]`);
      else unexpected.push(label);
    }
  }
  if (JSON.stringify(Object.keys(bf).sort()) !== JSON.stringify(Object.keys(af).sort())) {
    unexpected.push(`${FIT_CODE} fit strategies differ between the recordings`);
  }
  if (before.fit?.sessionDate !== after.fit?.sessionDate) {
    unexpected.push(`${FIT_CODE} fit session_date ${before.fit?.sessionDate} -> ${after.fit?.sessionDate} (the recordings must be the same session)`);
  }
  if (after.fit && after.dataStatus && after.fit.sessionDate !== after.dataStatus.snapshotAsOf) {
    unexpected.push(`${FIT_CODE} fit session_date ${after.fit.sessionDate} is not the snapshot's ${after.dataStatus.snapshotAsOf}`);
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
  return "usage: snapshot-cutover-check.mjs record --base-url <url> --out <file> [--token-env <VAR>] [--delay-ms <n>] | diff <before.json> <after.json>";
}

async function main(argv) {
  const { cmd, flags, positional } = parseArgs(argv);
  if (cmd === "record") {
    if (!flags["base-url"] || !flags.out) throw new Error(usage());
    const tokenVar = flags["token-env"] ?? "";
    const token = tokenVar ? process.env[tokenVar] ?? "" : "";
    if (tokenVar && !token) throw new Error(`--token-env ${tokenVar} is not set`);
    const delayMs = flags["delay-ms"] !== undefined ? Number(flags["delay-ms"]) : 2100;
    const rec = await record(flags["base-url"], { token, delayMs });
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
