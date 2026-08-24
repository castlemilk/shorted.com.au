// Results-filing watch: turn "this company just reported" into a Take candidate.
//
// The newsroom already knows how to research and write a company piece
// (discover → newsroom → publish). What it lacked was a trigger tied to the
// single most analysable moment in a listed company's year: the release of its
// financial results. Ordinary discovery is driven by short interest and news
// volume, which surfaces a company days AFTER the market has already digested
// the filing.
//
// ---------------------------------------------------------------------------
// WHY THIS DOES NOT USE announcement_type (measured on prod, 2026-08-24)
// ---------------------------------------------------------------------------
// The obvious implementation — `WHERE announcement_type = 'earnings'` — is
// wrong in both directions, and badly:
//
//   * Of 288 'earnings' rows in the trailing 21 days, **257 (89%) were
//     dividend/distribution admin notices** ("Dividend/Distribution - AMA"),
//     not results. Only 13 were actual FY/HY results.
//   * Meanwhile **4,106 Appendix 4D/4E announcements are classified 'other'**,
//     against just 25 in 'earnings'. Appendix 4E *is* the statutory full-year
//     results filing. The single most important document is in the junk bucket.
//
// So classification happens here, on the headline, and deliberately ignores
// announcement_type entirely. Fixing the upstream classifier is a separate
// (and much larger) job; this module must be correct regardless of it.

import type { Client as PgClient } from "pg";

/** What kind of results document an announcement headline describes. */
export type FilingKind =
  | "appendix_4de" // Appendix 4D (half year) / 4E (full year) — the statutory filing
  | "annual_report"
  | "period_results"; // "FY26 Results", "Half Year Results", "Interim Results"

export interface ResultsFiling {
  stockCode: string;
  announcementDate: string;
  headline: string;
  pdfUrl: string | null;
  kind: FilingKind;
}

/**
 * Headlines that CONTAIN results language but are not a results release.
 *
 * Every pattern here comes from a real headline observed in the table. These
 * matter more than the positive patterns: a scheduling notice or a webinar
 * invitation triggering a full research-and-write cycle wastes an LLM run and,
 * worse, produces an article analysing results that have not been published.
 */
const NOT_A_FILING = [
  /\bresults?\s+date\b/i, // "FY26 Results Date and Market Briefing"
  /\bwebinar\b/i, // "FY26 Results Webinar", "...at Coffee Microcaps Webinar"
  /\bto\s+present\b/i, // "AMX to present FY26 Results at ..."
  /\bconference\s+call\b/i,
  /\bbriefing\s+(?:details|invitation)\b/i,
  /\binvestor\s+(?:day|briefing)\b/i,
  // Any "Notice of ..." is an advance notice, never the filing itself.
  // "Notice of FY26 Results Market Briefing" reached the ranked output before
  // this was broadened from the original agm/meeting-only rule.
  /^notice\s+of\b/i,
  /\bnotice\s+of\s+(?:agm|meeting)\b/i,
  // Registration/dial-in logistics for a presentation.
  /\bregistration\s+details\b/i,
  /\bdial[-\s]?in\b/i,
  // AGM/EGM voting outcomes. "Results of Meeting" is not a financial result.
  /\bresults?\s+of\s+(?:the\s+)?(?:\d{4}\s+)?(?:annual\s+general\s+|general\s+|extraordinary\s+)?meeting\b/i,
  /\btranscript\b/i,
  // Dividend administration. "FY26 Financial Results and Dividend" is a real
  // filing, so this only excludes headlines that are ONLY about the dividend.
  /^(?:update\s*-\s*)?dividend\/distribution\b/i,
  /^confirmation of .*dividend/i,
];

/**
 * Positive patterns, most specific first. Order matters: an "Appendix 4E &
 * Annual Report" headline should be recorded as the statutory filing, which is
 * the stronger signal.
 */
const FILING_PATTERNS: Array<{ kind: FilingKind; rx: RegExp }> = [
  { kind: "appendix_4de", rx: /\bappendix\s*4[de]\b/i },
  { kind: "annual_report", rx: /\bannual\s+report\b/i },
  {
    kind: "period_results",
    rx: /\b(?:fy\s?\d{2,4}|hy\s?\d{2,4}|full[-\s]?year|half[-\s]?year|interim|preliminary\s+final)\b[^.]{0,40}\b(?:results?|financial\s+report|financial\s+statements?)\b/i,
  },
  {
    kind: "period_results",
    rx: /\b(?:results?|financial\s+report)\b[^.]{0,30}\bfor\s+(?:the\s+)?(?:year|half[-\s]?year|period)\b/i,
  },
];

/**
 * Markers strong enough to override an exclusion.
 *
 * A headline can legitimately be both a filing and an event notice — the real
 * "FY26 Financial Results Release and Webinar" was being thrown away by the
 * webinar rule, exactly as the real "FY26 Financial Results and Dividend" was
 * nearly thrown away by the dividend rule. The differentiator is whether the
 * headline says the results were RELEASED, not merely scheduled or discussed.
 *
 * Found by running the classifier over 632 real headlines rather than by
 * reasoning about it — the unit tests passed while both cases were broken.
 */
const STRONG_FILING = [
  /\bappendix\s*4[de]\b/i,
  /\bresults?\s+(?:release|announcement|summary)\b/i,
  /\bfinancial\s+results?\s+(?:release|announcement|summary)\b/i,
  /\bfinancial\s+report\s+for\b/i,
];

/**
 * Classify an announcement headline. Returns null when it is not a results
 * filing — which is the common case, and must stay cheap.
 */
export function classifyResultsFiling(headline: string): FilingKind | null {
  if (!headline) return null;
  const strong = STRONG_FILING.some((rx) => rx.test(headline));
  if (!strong) {
    for (const rx of NOT_A_FILING) {
      if (rx.test(headline)) return null;
    }
  }
  for (const { kind, rx } of FILING_PATTERNS) {
    if (rx.test(headline)) return kind;
  }
  return null;
}

/**
 * Rank filings so the most analysable company wins when there is a queue.
 *
 * During reporting season several dozen companies report on the same day, and
 * an LLM research cycle is not free. Short interest is the ranking signal
 * because it is what this publication is about: a heavily-shorted company
 * reporting is a genuine event with two sides to it, while an unshorted
 * micro-cap filing an annual report is not a story.
 */
export function rankFilings(
  filings: ResultsFiling[],
  shortPctByCode: Map<string, number>,
): ResultsFiling[] {
  const kindWeight: Record<FilingKind, number> = {
    appendix_4de: 2,
    period_results: 2,
    annual_report: 1,
  };
  return [...filings].sort((a, b) => {
    const sa = (shortPctByCode.get(a.stockCode) ?? 0) * kindWeight[a.kind];
    const sb = (shortPctByCode.get(b.stockCode) ?? 0) * kindWeight[b.kind];
    if (sb !== sa) return sb - sa;
    return a.stockCode.localeCompare(b.stockCode);
  });
}

/**
 * Results filings released in the last `sinceDays` days.
 *
 * Deliberately over-selects in SQL (a cheap headline prefilter) and classifies
 * in TypeScript, so the classifier stays unit-testable and the regexes live in
 * one place rather than being duplicated into Postgres syntax.
 *
 * Announcements that already have a published take for the same stock inside
 * the window are excluded — reporting on the same company twice off one filing
 * is the most likely way this pipeline embarrasses itself.
 */
export async function findRecentResultsFilings(
  pg: PgClient,
  opts: { sinceDays?: number } = {},
): Promise<ResultsFiling[]> {
  const sinceDays = opts.sinceDays ?? 3;

  const { rows } = await pg.query<{
    stock_code: string;
    announcement_date: string;
    headline: string;
    pdf_url: string | null;
  }>(
    `SELECT a.stock_code, a.announcement_date::text, a.headline, a.pdf_url
       FROM asx_announcements a
      WHERE a.announcement_date >= CURRENT_DATE - $1::int
        AND (a.headline ~* 'appendix 4[de]'
          OR a.headline ~* 'annual report'
          OR a.headline ~* 'result'
          OR a.headline ~* 'financial report')
        AND NOT EXISTS (
              SELECT 1 FROM editorial_takes t
               WHERE t.stock_code = a.stock_code
                 AND t.created_at >= CURRENT_DATE - $1::int
            )
      ORDER BY a.announcement_date DESC, a.stock_code`,
    [sinceDays],
  );

  const seen = new Set<string>();
  const filings: ResultsFiling[] = [];
  for (const r of rows) {
    const kind = classifyResultsFiling(r.headline);
    if (!kind) continue;
    // One filing per company per run. A company routinely posts the 4E, the
    // annual report and the results presentation within minutes of each other.
    if (seen.has(r.stock_code)) continue;
    seen.add(r.stock_code);
    filings.push({
      stockCode: r.stock_code,
      announcementDate: r.announcement_date,
      headline: r.headline,
      pdfUrl: r.pdf_url,
      kind,
    });
  }
  return filings;
}

/**
 * CLI entry: report which companies have just filed results, ranked.
 *
 * Read-only. This is the trigger half of the pipeline — feed a stock code from
 * here into `newsroom --stock=...` to research and write the piece.
 */
export async function runResultsWatch(
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<void> {
  const { Client } = await import("pg");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  const pg = new Client({ connectionString: dbUrl });
  await pg.connect();
  try {
    const filings = await findRecentResultsFilings(pg, { sinceDays: opts.sinceDays });

    // Short interest is the ranking signal; a filing from an unshorted
    // micro-cap is not a story for this publication.
    const { rows } = await pg.query<{ product_code: string; pct: string }>(
      `SELECT DISTINCT ON ("PRODUCT_CODE") "PRODUCT_CODE" AS product_code,
              "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"::text AS pct
         FROM shorts
        WHERE "PRODUCT_CODE" = ANY($1::text[])
        ORDER BY "PRODUCT_CODE", "DATE" DESC`,
      [filings.map((f) => f.stockCode)],
    );
    const shortPct = new Map(rows.map((r) => [r.product_code, parseFloat(r.pct) || 0]));

    const ranked = rankFilings(filings, shortPct).slice(0, opts.limit ?? 20);

    console.log(`\n${filings.length} results filing(s) in the last ${opts.sinceDays ?? 3} day(s); top ${ranked.length} by short interest:\n`);
    console.log(`${"CODE".padEnd(6)} ${"SHORT%".padStart(7)}  ${"KIND".padEnd(14)} ${"DATE".padEnd(11)} HEADLINE`);
    for (const f of ranked) {
      const pct = shortPct.get(f.stockCode);
      console.log(
        `${f.stockCode.padEnd(6)} ${(pct !== undefined ? pct.toFixed(2) : "-").padStart(7)}  ${f.kind.padEnd(14)} ${f.announcementDate.padEnd(11)} ${f.headline.slice(0, 62)}`,
      );
    }
    if (ranked.length) {
      console.log(`\nresearch + write the top one:`);
      console.log(`  npx tsx src/index.ts newsroom --stock=${ranked[0]!.stockCode}`);
    }
  } finally {
    await pg.end();
  }
}
