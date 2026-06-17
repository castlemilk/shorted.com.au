/**
 * Bake the big-four bank short-position series into a typed, immutable TS module
 * consumed by <BankShortBasket />. No live endpoint returns short SHARES × price
 * as a historical series (GetStockData exposes only percent), so the dollar story
 * must be pre-computed via a shorts × stock_prices JOIN and shipped as static data.
 *
 * Output: web/src/@/components/news/mdx/data/bank-basket-series.ts
 *   - shared weekly date spine (forward-filled — a hole in any band punches a hole
 *     in the stacked ceiling), per-bank percent[] + dollar[] (AUD billions),
 *     and BASKET_RECORD (the peak summed-dollar point).
 *
 * Run: cd scripts/take-writer && \
 *   DATABASE_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL \
 *     --project=rosy-clover-477102-t5 --account=ben@shorted.com.au) \
 *   npx tsx src/bake-bank-basket.ts
 */
import { Pool } from "pg";
import { writeFileSync } from "fs";
import { resolve } from "path";

const CODES = ["CBA", "WBC", "NAB", "ANZ"] as const;
const WEEKS = 104; // ~2 years of weekly samples — the window control slices 3m/6m/1y
// Run from scripts/take-writer (see header). Resolve the web data module from cwd.
const OUT = resolve(
  process.cwd(),
  "../../web/src/@/components/news/mdx/data/bank-basket-series.ts",
);

interface WeekRow {
  week: string; // YYYY-MM-DD (Monday of the ISO week)
  cba_pct: number | null; wbc_pct: number | null; nab_pct: number | null; anz_pct: number | null;
  cba_val: number | null; wbc_val: number | null; nab_val: number | null; anz_val: number | null;
}

const SQL = `
WITH base AS (
  SELECT "PRODUCT_CODE" code,
         date_trunc('week', "DATE") wk,
         "DATE"::date d,
         "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" pct,
         "REPORTED_SHORT_POSITIONS" shares
  FROM shorts
  WHERE "PRODUCT_CODE" = ANY($1)
    AND "DATE" >= now() - interval '${WEEKS} weeks'
),
wk AS (
  SELECT DISTINCT ON (code, wk) code, wk::date AS week, d, pct, shares
  FROM base ORDER BY code, wk, d DESC
),
priced AS (
  SELECT wk.week, wk.code, wk.pct,
         round((wk.shares * p.close)::numeric / 1e9, 4) AS val_bn
  FROM wk
  LEFT JOIN LATERAL (
    SELECT close FROM stock_prices sp
    WHERE sp.stock_code = wk.code AND sp.date <= wk.d
    ORDER BY sp.date DESC LIMIT 1
  ) p ON true
)
SELECT week::text,
  round(max(pct) FILTER (WHERE code='CBA')::numeric,3) AS cba_pct,
  round(max(pct) FILTER (WHERE code='WBC')::numeric,3) AS wbc_pct,
  round(max(pct) FILTER (WHERE code='NAB')::numeric,3) AS nab_pct,
  round(max(pct) FILTER (WHERE code='ANZ')::numeric,3) AS anz_pct,
  max(val_bn) FILTER (WHERE code='CBA') AS cba_val,
  max(val_bn) FILTER (WHERE code='WBC') AS wbc_val,
  max(val_bn) FILTER (WHERE code='NAB') AS nab_val,
  max(val_bn) FILTER (WHERE code='ANZ') AS anz_val
FROM priced
GROUP BY week
ORDER BY week ASC;
`;

/**
 * Forward-fill nulls so the stacked ceiling never drops to 0. Warns when it
 * actually substitutes — a leading-null run becomes a misleading 0-height band,
 * so future bakes surface a price/ASIC coverage gap instead of masking it.
 */
function forwardFill(arr: (number | null)[], label: string): number[] {
  let last = 0;
  let leading = 0;
  let seen = false;
  let filled = 0;
  const out = arr.map((v) => {
    if (v == null || Number.isNaN(v)) {
      if (!seen) leading++;
      filled++;
      return last;
    }
    seen = true;
    last = v;
    return v;
  });
  if (filled > 0) {
    console.warn(
      `forward-fill: ${label} patched ${filled} week(s)` +
        (leading > 0 ? ` (${leading} leading zeros — band starts flat!)` : ""),
    );
  }
  return out;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query<WeekRow>(SQL, [CODES as unknown as string[]]);
  await pool.end();
  if (rows.length < 10) throw new Error(`Too few rows (${rows.length}) — aborting bake`);

  const dates = rows.map((r) => new Date(r.week + "T00:00:00Z").getTime());
  const num = (v: number | string | null) => (v == null ? null : Number(v));

  const pct: Record<string, number[]> = {
    CBA: forwardFill(rows.map((r) => num(r.cba_pct)), "CBA pct"),
    WBC: forwardFill(rows.map((r) => num(r.wbc_pct)), "WBC pct"),
    NAB: forwardFill(rows.map((r) => num(r.nab_pct)), "NAB pct"),
    ANZ: forwardFill(rows.map((r) => num(r.anz_pct)), "ANZ pct"),
  };
  const dollar: Record<string, number[]> = {
    CBA: forwardFill(rows.map((r) => num(r.cba_val)), "CBA val"),
    WBC: forwardFill(rows.map((r) => num(r.wbc_val)), "WBC val"),
    NAB: forwardFill(rows.map((r) => num(r.nab_val)), "NAB val"),
    ANZ: forwardFill(rows.map((r) => num(r.anz_val)), "ANZ val"),
  };

  // Peak summed-dollar point = the record basket.
  let recVal = -1, recIdx = 0;
  for (let i = 0; i < dates.length; i++) {
    const sum = CODES.reduce((s, c) => s + (dollar[c]![i] ?? 0), 0);
    if (sum > recVal) { recVal = sum; recIdx = i; }
  }

  const asOf = rows[rows.length - 1]!.week;
  const latestTotal = CODES.reduce((s, c) => s + dollar[c]![dates.length - 1]!, 0);
  const cbaShare = (dollar.CBA![dates.length - 1]! / latestTotal) * 100;

  const banner =
    `// AUTO-GENERATED by scripts/take-writer/src/bake-bank-basket.ts — DO NOT EDIT BY HAND.\n` +
    `// Short value = REPORTED_SHORT_POSITIONS × last close, weekly, ASIC data.\n` +
    `// asOf=${asOf} · weeks=${dates.length} · latest basket=$${latestTotal.toFixed(2)}bn · CBA=${cbaShare.toFixed(0)}% · record=$${recVal.toFixed(2)}bn\n`;

  const body = `${banner}
export interface BankBasketSeries {
  /** ISO date (YYYY-MM-DD) of the latest weekly reading. */
  asOf: string;
  /** ASX codes, stack order bottom→top. */
  codes: readonly string[];
  /** Shared weekly spine, epoch ms, ascending. */
  dates: number[];
  /** code → short interest percent of issue, per date. */
  pct: Record<string, number[]>;
  /** code → short value in AUD billions (shares × close), per date. */
  dollar: Record<string, number[]>;
}

export const BANK_BASKET_SERIES: BankBasketSeries = ${JSON.stringify(
    { asOf, codes: CODES, dates, pct, dollar },
    null,
    2,
  )};

/** The peak summed-dollar basket across the spine — the "record" the prose cites. */
export const BASKET_RECORD = { valueBn: ${Number(recVal.toFixed(3))}, date: ${dates[recIdx]} } as const;
`;

  writeFileSync(OUT, body);
  console.log(`Wrote ${OUT}`);
  console.log(banner.trim());
}

main().catch((e) => { console.error(e); process.exit(1); });
