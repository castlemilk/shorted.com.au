# Investigative Newsroom Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `scripts/take-writer/` from a single-LLM-call generator into a daily investigative newsroom: a Claude editor commissions stories (novelty-gated), Claude investigators gather evidence via live data tools into a grounded dossier, and Gemini writes tiered Takes/deep-dives that can only cite sources actually retrieved.

**Architecture:** Three-stage pipeline (editor → investigator → writer) run by a daily Cloud Run Job. Claude (Sonnet for editor + Takes, Opus for deep-dives) does tool-calling investigation and emits a structured dossier + citation ledger; Gemini 2.5 writes the prose in the tuned Shorted voice citing only ledger `refId`s; a validate-before-insert step drops dangling citations. Writes into the existing `editorial_takes` table (+ a new `tier` column) and reuses the existing image-gen and draft/publish/tweet pipeline.

**Tech Stack:** TypeScript + tsx (existing), `@anthropic-ai/sdk` (new), `@google/generative-ai` (existing writer), `pg` (existing), `vitest` (new, tests), Postgres migration, Terraform (Cloud Run Job + Cloud Scheduler).

**Spec:** `docs/superpowers/specs/2026-05-30-investigative-newsroom-design.md`

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `scripts/take-writer/vitest.config.ts` | Test runner config | New |
| `scripts/take-writer/package.json` | Add `@anthropic-ai/sdk`, vitest, test script | Modify |
| `scripts/take-writer/src/ledger.ts` | Citation ledger: register retrieved sources → stable refIds; compact/validate body citations against the ledger | New |
| `scripts/take-writer/src/drilldowns.ts` | Pure DB drill-down query functions (zoom window, follow peer, report line, align events, news detail, search news) | New |
| `scripts/take-writer/src/tools.ts` | Anthropic tool schema + dispatch wrapping `drilldowns.ts`, accumulating sources into the ledger | New |
| `scripts/take-writer/src/investigator.ts` | Claude agentic tool-calling loop → `Dossier` (turn/token capped) | New |
| `scripts/take-writer/src/editor.ts` | Claude editor: signal board → novelty gate → `Assignment[]` | New |
| `scripts/take-writer/src/journalism.ts` | Add `lastTakeDateForStock`, `buildSignalBoard` | Modify |
| `scripts/take-writer/src/narrative.ts` | Add `synthesiseFromDossier` (tiered writer, ledger-refId-only) + `WRITER_MODEL` env | Modify |
| `scripts/take-writer/src/newsroom.ts` | Add `runNewsroomDaily` (editor→investigator→writer, model tiering, caps, cost log, validate-before-insert) + `tier` insert | Modify |
| `scripts/take-writer/src/index.ts` | Add `newsroom-daily` command + caps from env/flags | Modify |
| `services/migrations/000038_editorial_takes_tier.up.sql` / `.down.sql` | `tier` column | New |
| `terraform/modules/newsroom-job/{main,variables,outputs}.tf` | Cloud Run Job + Scheduler + IAM | New |
| `terraform/environments/dev/main.tf` | Reference the module | Modify |

**Type contracts (defined once, referenced everywhere):**

```typescript
// ledger.ts
export type LedgerSourceType = "news" | "report" | "director";
export interface LedgerSource {
  type: LedgerSourceType;
  url: string;
  source: string;     // publisher / report type / "director trade"
  headline: string;   // headline / report title / trade description
  date: string;       // YYYY-MM-DD
}

// editor.ts
export interface Assignment {
  stockCode: string;
  angle: string;
  tier: "take" | "deep_dive";
  rationale: string;
}

// investigator.ts
export interface DossierThread { claim: string; evidenceRefIds: string[]; note?: string }
export interface DossierTimelineItem { date: string; event: string; refIds: string[] }
export interface DossierKeyNumber { label: string; value: string; refId?: string }
export interface Dossier {
  stockCode: string;
  tier: "take" | "deep_dive";
  angle: string;
  summary: string;
  threads: DossierThread[];
  timeline?: DossierTimelineItem[];
  keyNumbers: DossierKeyNumber[];
}
```

The `Citation` type already exists in `narrative.ts` (`{ refId, url, source, headline, date, type }`) and is the on-disk shape in `editorial_takes.citations`. The ledger produces `Citation[]` so nothing downstream changes.

---

## Task 1: Test tooling + Anthropic SDK

**Files:**
- Modify: `scripts/take-writer/package.json`
- Create: `scripts/take-writer/vitest.config.ts`

- [ ] **Step 1: Add deps and test script to package.json**

Edit the `dependencies` and `devDependencies` / `scripts` blocks so they read:

```json
  "scripts": {
    "draft": "tsx src/index.ts draft",
    "pick": "tsx src/index.ts pick",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.69.0",
    "@google-cloud/storage": "^7.19.0",
    "@google/generative-ai": "^0.21.0",
    "@types/pg": "^8.20.0",
    "dotenv": "^16.4.5",
    "openai": "^6.38.0",
    "pg": "^8.21.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
```

- [ ] **Step 2: Create vitest config**

`scripts/take-writer/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Install**

Run: `cd scripts/take-writer && npm install`
Expected: installs `@anthropic-ai/sdk` and `vitest`, exit 0.

- [ ] **Step 4: Verify vitest runs (no tests yet)**

Run: `cd scripts/take-writer && npm test`
Expected: vitest reports "No test files found" — that's fine, exit code may be non-zero. Confirms the runner is wired.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/package.json scripts/take-writer/package-lock.json scripts/take-writer/vitest.config.ts
git commit -m "chore(take-writer): add anthropic sdk + vitest test tooling"
```

---

## Task 2: Schema migration — `tier` column

**Files:**
- Create: `services/migrations/000038_editorial_takes_tier.up.sql`
- Create: `services/migrations/000038_editorial_takes_tier.down.sql`

- [ ] **Step 1: Write the up migration**

`services/migrations/000038_editorial_takes_tier.up.sql`:

```sql
-- Tiered editorial output: most takes are tight 4-section "take"s; a
-- couple per day are promoted to long-form "deep_dive" investigations.
-- The investigative newsroom (scripts/take-writer) sets this.
ALTER TABLE editorial_takes
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'take';

-- Allowed values: 'take' | 'deep_dive'. Enforced in app, documented here.
COMMENT ON COLUMN editorial_takes.tier IS 'take | deep_dive';
```

- [ ] **Step 2: Write the down migration**

`services/migrations/000038_editorial_takes_tier.down.sql`:

```sql
ALTER TABLE editorial_takes DROP COLUMN IF EXISTS tier;
```

- [ ] **Step 3: Apply against the dev DB**

Run: `cd services && make migrate-up`
Expected: migration 000038 applies; `make migrate-version` shows 38.

- [ ] **Step 4: Verify the column exists**

Run: `psql postgresql://admin:password@localhost:5438/shorts -c "\d editorial_takes" | grep tier`
Expected: a `tier | character varying(20) | not null | 'take'::character varying` row.

- [ ] **Step 5: Commit**

```bash
git add services/migrations/000038_editorial_takes_tier.up.sql services/migrations/000038_editorial_takes_tier.down.sql
git commit -m "feat(db): add tier column to editorial_takes (migration 000038)"
```

---

## Task 3: Citation ledger

**Files:**
- Create: `scripts/take-writer/src/ledger.ts`
- Test: `scripts/take-writer/src/ledger.test.ts`

- [ ] **Step 1: Write failing tests**

`scripts/take-writer/src/ledger.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CitationLedger, compactCitations } from "./ledger.js";

const src = (over: Partial<import("./ledger.js").LedgerSource> = {}) => ({
  type: "news" as const,
  url: "https://ex.com/a",
  source: "Stockhead",
  headline: "A headline",
  date: "2026-05-01",
  ...over,
});

describe("CitationLedger", () => {
  it("assigns sequential refIds in registration order", () => {
    const l = new CitationLedger();
    expect(l.register(src({ url: "https://ex.com/a" }))).toBe("ref-1");
    expect(l.register(src({ url: "https://ex.com/b" }))).toBe("ref-2");
  });

  it("dedupes by type+url, returning the existing refId", () => {
    const l = new CitationLedger();
    const first = l.register(src({ url: "https://ex.com/a" }));
    const again = l.register(src({ url: "https://ex.com/a", headline: "changed" }));
    expect(again).toBe(first);
    expect(l.size()).toBe(1);
  });

  it("knows whether a refId is in the ledger", () => {
    const l = new CitationLedger();
    l.register(src());
    expect(l.has("ref-1")).toBe(true);
    expect(l.has("ref-9")).toBe(false);
  });
});

describe("compactCitations", () => {
  it("drops markers not in the ledger and renumbers cited ones in first-appearance order", () => {
    const l = new CitationLedger();
    l.register(src({ url: "https://ex.com/a", type: "news" }));     // ref-1
    l.register(src({ url: "https://ex.com/b", type: "report" }));   // ref-2
    l.register(src({ url: "https://ex.com/c", type: "news" }));     // ref-3
    // Body cites ref-3 then ref-1, and a bogus ref-8 that must be dropped.
    const body = "First [ref-3]. Then [ref-1]. Bogus [ref-8].";
    const { body: out, citations } = compactCitations(body, l);
    expect(out).toBe("First [ref-1]. Then [ref-2]. Bogus .");
    expect(citations.map((c) => c.refId)).toEqual(["ref-1", "ref-2"]);
    expect(citations[0]!.url).toBe("https://ex.com/c");
    expect(citations[1]!.url).toBe("https://ex.com/a");
    expect(citations[1]!.type).toBe("news");
  });

  it("reports dangling markers it dropped", () => {
    const l = new CitationLedger();
    l.register(src());
    const { dropped } = compactCitations("ok [ref-1] bad [ref-7]", l);
    expect(dropped).toEqual(["ref-7"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/take-writer && npx vitest run src/ledger.test.ts`
Expected: FAIL — `Cannot find module './ledger.js'`.

- [ ] **Step 3: Implement the ledger**

`scripts/take-writer/src/ledger.ts`:

```typescript
// Citation ledger — the grounding spine of the investigative newsroom.
//
// Every source the investigation agent actually retrieves via a data
// tool is registered here and handed a stable refId. The writer may
// ONLY cite refIds that exist in the ledger; compactCitations() drops
// any marker the writer invents and renumbers the survivors into the
// contiguous ref-1..M sequence the frontend (LinkifiedNarrative +
// editorial_takes.citations) already understands.

import type { Citation } from "./narrative.js";

export type LedgerSourceType = "news" | "report" | "director";

export interface LedgerSource {
  type: LedgerSourceType;
  url: string;
  source: string;
  headline: string;
  date: string; // YYYY-MM-DD
}

export class CitationLedger {
  private byKey = new Map<string, string>();   // type:url -> refId
  private byRefId = new Map<string, LedgerSource>();
  private seq = 0;

  private key(s: LedgerSource): string {
    return `${s.type}:${s.url}`;
  }

  /** Register a retrieved source; returns its stable refId. Idempotent on type+url. */
  register(s: LedgerSource): string {
    const k = this.key(s);
    const existing = this.byKey.get(k);
    if (existing) return existing;
    this.seq += 1;
    const refId = `ref-${this.seq}`;
    this.byKey.set(k, refId);
    this.byRefId.set(refId, s);
    return refId;
  }

  has(refId: string): boolean {
    return this.byRefId.has(refId);
  }

  get(refId: string): LedgerSource | undefined {
    return this.byRefId.get(refId);
  }

  size(): number {
    return this.byRefId.size;
  }
}

const MARKER = /\[(ref-\d+)\]/g;

/**
 * Walk the body, drop any [ref-N] not in the ledger, and renumber the
 * cited-and-valid markers into contiguous ref-1..M in first-appearance
 * order. Returns the rewritten body, the ordered Citation[] for the
 * editorial_takes.citations column, and the dropped (dangling) marker ids.
 */
export function compactCitations(
  body: string,
  ledger: CitationLedger,
): { body: string; citations: Citation[]; dropped: string[] } {
  const remap = new Map<string, string>();
  const ordered: LedgerSource[] = [];
  const dropped: string[] = [];
  let assigned = 0;

  for (const m of body.matchAll(MARKER)) {
    const id = m[1]!;
    if (remap.has(id)) continue;
    const srcRec = ledger.get(id);
    if (!srcRec) {
      if (!dropped.includes(id)) dropped.push(id);
      continue;
    }
    assigned += 1;
    const to = `ref-${assigned}`;
    remap.set(id, to);
    ordered.push(srcRec);
  }

  const outBody = body.replace(MARKER, (whole, id: string) => {
    if (remap.has(id)) return `[${remap.get(id)}]`;
    return ""; // drop dangling marker
  });

  const citations: Citation[] = ordered.map((s, i) => ({
    refId: `ref-${i + 1}`,
    url: s.url,
    source: s.source,
    headline: s.headline,
    date: s.date,
    type: s.type === "director" ? "trade" : s.type, // Citation.type has no 'director'; map to 'trade'
  }));

  return { body: outBody, citations, dropped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/take-writer && npx vitest run src/ledger.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/src/ledger.ts scripts/take-writer/src/ledger.test.ts
git commit -m "feat(take-writer): citation ledger + compactCitations grounding primitive"
```

---

## Task 4: Drill-down DB queries

**Files:**
- Create: `scripts/take-writer/src/drilldowns.ts`
- Test: `scripts/take-writer/src/drilldowns.test.ts`

These are thin, incremental queries (windows around a date, one peer, one report line) — NOT full re-fetches. They take a minimal pg-query interface so tests can inject a fake.

- [ ] **Step 1: Write failing tests**

`scripts/take-writer/src/drilldowns.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { zoomWindow, reportLine, searchNews, type Queryable } from "./drilldowns.js";

function fakePg(capture: { sql: string; params: unknown[] }[], rows: unknown[]): Queryable {
  return {
    async query(sql: string, params?: unknown[]) {
      capture.push({ sql, params: params ?? [] });
      return { rows } as { rows: unknown[] };
    },
  };
}

describe("zoomWindow", () => {
  it("queries shorts+prices+news in a +/- day window around a date", async () => {
    const cap: { sql: string; params: unknown[] }[] = [];
    const pg = fakePg(cap, []);
    await zoomWindow(pg, "BHP", "2026-05-01", 3);
    // 3 queries: shorts, prices, news — all parameterised with the code.
    expect(cap.length).toBe(3);
    expect(cap.every((c) => c.params.includes("BHP"))).toBe(true);
    expect(cap.every((c) => c.params.some((p) => String(p).includes("2026-05-01")))).toBe(true);
  });
});

describe("reportLine", () => {
  it("returns the metric value + source record for a stock", async () => {
    const cap: { sql: string; params: unknown[] }[] = [];
    const pg = fakePg(cap, [{
      report_url: "https://x/r.pdf", report_type: "annual_results",
      report_title: "FY25", report_date: "2026-02-01",
      metrics: { revenue: "A$1.2bn", ebitda: "A$300m" },
    }]);
    const out = await reportLine(pg, "BHP", "revenue");
    expect(out?.value).toBe("A$1.2bn");
    expect(out?.source.type).toBe("report");
    expect(out?.source.url).toBe("https://x/r.pdf");
  });

  it("returns null when the metric is absent", async () => {
    const pg = fakePg([], [{ report_url: "u", report_type: null, report_title: null, report_date: null, metrics: {} }]);
    expect(await reportLine(pg, "BHP", "revenue")).toBeNull();
  });
});

describe("searchNews", () => {
  it("parameterises the query string and optional code", async () => {
    const cap: { sql: string; params: unknown[] }[] = [];
    const pg = fakePg(cap, []);
    await searchNews(pg, "probe", "DRO");
    expect(cap[0]!.params).toContain("DRO");
    expect(cap[0]!.params.some((p) => String(p).includes("probe"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/take-writer && npx vitest run src/drilldowns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement drill-downs**

`scripts/take-writer/src/drilldowns.ts`:

```typescript
// Incremental drill-down queries used by the investigation agent's
// tools. Each zooms into a slice of the data the agent already has a
// summary of — a window around a date, one peer, one report line — so
// the loop stays cheap instead of re-sending 365-day series each turn.

import type { LedgerSource } from "./ledger.js";

/** Minimal slice of pg.Client we need — lets tests inject a fake. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface WindowResult {
  shorts: Array<{ date: string; pct: number }>;
  prices: Array<{ date: string; close: number; volume: number }>;
  news: Array<{ id: string; date: string; source: string; headline: string; url: string; sentiment: string | null }>;
}

export async function zoomWindow(
  pg: Queryable,
  code: string,
  date: string,
  days: number,
): Promise<WindowResult> {
  const lo = `${date} -${days} days`;
  const hi = `${date} +${days} days`;
  const shortsQ = pg.query(
    `SELECT to_char("DATE",'YYYY-MM-DD') AS date,
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS pct
     FROM shorts
     WHERE "PRODUCT_CODE"=$1 AND "DATE" BETWEEN $2::timestamp AND $3::timestamp
     ORDER BY "DATE" ASC`,
    [code, lo, hi],
  );
  const pricesQ = pg.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, close, volume
     FROM stock_prices
     WHERE stock_code=$1 AND date BETWEEN $2::date AND $3::date
     ORDER BY date ASC`,
    [code, lo, hi],
  );
  const newsQ = pg.query(
    `SELECT id::text, to_char(published_at,'YYYY-MM-DD') AS date, source, headline, url, sentiment
     FROM news_articles
     WHERE stock_code=$1 AND published_at BETWEEN $2::timestamp AND $3::timestamp
     ORDER BY published_at ASC LIMIT 40`,
    [code, lo, hi],
  );
  const [s, p, n] = await Promise.all([shortsQ, pricesQ, newsQ]);
  return {
    shorts: (s.rows as Array<{ date: string; pct: string }>).map((r) => ({ date: r.date, pct: Number(r.pct) })),
    prices: (p.rows as Array<{ date: string; close: string; volume: string }>).map((r) => ({ date: r.date, close: Number(r.close), volume: Number(r.volume) })),
    news: n.rows as WindowResult["news"],
  };
}

export interface ReportLineResult {
  value: string;
  reportType: string | null;
  reportDate: string | null;
  source: LedgerSource;
}

export async function reportLine(
  pg: Queryable,
  code: string,
  metric: string,
): Promise<ReportLineResult | null> {
  const { rows } = await pg.query(
    `SELECT report_url, report_type, report_title,
            to_char(report_date,'YYYY-MM-DD') AS report_date, metrics
     FROM financial_report_extractions
     WHERE stock_code=$1
     ORDER BY report_date DESC NULLS LAST, extracted_at DESC
     LIMIT 6`,
    [code],
  );
  for (const r of rows as Array<{ report_url: string; report_type: string | null; report_title: string | null; report_date: string | null; metrics: Record<string, unknown> | null }>) {
    const m = r.metrics ?? {};
    if (metric in m && m[metric] != null) {
      return {
        value: String(m[metric]),
        reportType: r.report_type,
        reportDate: r.report_date,
        source: {
          type: "report",
          url: r.report_url,
          source: r.report_type ?? "report",
          headline: r.report_title ?? "(financial report)",
          date: r.report_date ?? "",
        },
      };
    }
  }
  return null;
}

export interface FollowPeerResult {
  shorts: Array<{ date: string; pct: number }>;
  prices: Array<{ date: string; close: number }>;
}

export async function followPeer(
  pg: Queryable,
  peerCode: string,
  days = 180,
): Promise<FollowPeerResult> {
  const sQ = pg.query(
    `SELECT to_char("DATE",'YYYY-MM-DD') AS date,
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS pct
     FROM shorts WHERE "PRODUCT_CODE"=$1 AND "DATE" > NOW() - $2::interval ORDER BY "DATE" ASC`,
    [peerCode, `${days} days`],
  );
  const pQ = pg.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, close FROM stock_prices
     WHERE stock_code=$1 AND date > NOW() - $2::interval ORDER BY date ASC`,
    [peerCode, `${days} days`],
  );
  const [s, p] = await Promise.all([sQ, pQ]);
  return {
    shorts: (s.rows as Array<{ date: string; pct: string }>).map((r) => ({ date: r.date, pct: Number(r.pct) })),
    prices: (p.rows as Array<{ date: string; close: string }>).map((r) => ({ date: r.date, close: Number(r.close) })),
  };
}

export interface AlignEventsItem {
  date: string;
  kind: "director_trade" | "news";
  detail: string;
  source: LedgerSource;
}

export async function alignEvents(
  pg: Queryable,
  code: string,
  days = 180,
): Promise<AlignEventsItem[]> {
  const tradesQ = pg.query(
    `SELECT to_char(trade_date,'YYYY-MM-DD') AS date, director_name, trade_type,
            total_value, announcement_url
     FROM director_trades WHERE stock_code=$1 AND trade_date > NOW() - $2::interval
     ORDER BY trade_date DESC LIMIT 50`,
    [code, `${days} days`],
  );
  const newsQ = pg.query(
    `SELECT id::text, to_char(published_at,'YYYY-MM-DD') AS date, source, headline, url
     FROM news_articles WHERE stock_code=$1 AND is_price_sensitive=true
       AND published_at > NOW() - $2::interval ORDER BY published_at DESC LIMIT 40`,
    [code, `${days} days`],
  );
  const [t, n] = await Promise.all([tradesQ, newsQ]);
  const out: AlignEventsItem[] = [];
  for (const r of t.rows as Array<{ date: string; director_name: string; trade_type: string; total_value: string | null; announcement_url: string | null }>) {
    out.push({
      date: r.date,
      kind: "director_trade",
      detail: `${r.director_name} ${r.trade_type}${r.total_value ? ` A$${r.total_value}` : ""}`,
      source: { type: "director", url: r.announcement_url ?? "", source: "director trade", headline: `${r.director_name} ${r.trade_type}`, date: r.date },
    });
  }
  for (const r of n.rows as Array<{ id: string; date: string; source: string; headline: string; url: string }>) {
    out.push({ date: r.date, kind: "news", detail: r.headline, source: { type: "news", url: r.url, source: r.source, headline: r.headline, date: r.date } });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

export interface NewsDetailResult {
  id: string; date: string; source: string; headline: string; url: string;
  sentiment: string | null; summary: string | null; ledgerSource: LedgerSource;
}

export async function newsDetail(pg: Queryable, articleId: string): Promise<NewsDetailResult | null> {
  const { rows } = await pg.query(
    `SELECT id::text, to_char(published_at,'YYYY-MM-DD') AS date, source, headline, url, sentiment, summary
     FROM news_articles WHERE id=$1::uuid LIMIT 1`,
    [articleId],
  );
  const r = (rows as Array<{ id: string; date: string; source: string; headline: string; url: string; sentiment: string | null; summary: string | null }>)[0];
  if (!r) return null;
  return { ...r, ledgerSource: { type: "news", url: r.url, source: r.source, headline: r.headline, date: r.date } };
}

export interface SearchNewsItem {
  id: string; date: string; source: string; headline: string; url: string; ledgerSource: LedgerSource;
}

export async function searchNews(pg: Queryable, query: string, code?: string): Promise<SearchNewsItem[]> {
  const params: unknown[] = [`%${query}%`];
  let codeClause = "";
  if (code) { params.push(code); codeClause = `AND stock_code=$${params.length}`; }
  const { rows } = await pg.query(
    `SELECT id::text, to_char(published_at,'YYYY-MM-DD') AS date, source, headline, url
     FROM news_articles
     WHERE (headline ILIKE $1 OR summary ILIKE $1) ${codeClause}
     ORDER BY published_at DESC LIMIT 25`,
    params,
  );
  return (rows as Array<{ id: string; date: string; source: string; headline: string; url: string }>).map((r) => ({
    ...r, ledgerSource: { type: "news", url: r.url, source: r.source, headline: r.headline, date: r.date },
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/take-writer && npx vitest run src/drilldowns.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/src/drilldowns.ts scripts/take-writer/src/drilldowns.test.ts
git commit -m "feat(take-writer): incremental drill-down DB queries for investigation tools"
```

---

## Task 5: Tool registry + dispatch

**Files:**
- Create: `scripts/take-writer/src/tools.ts`
- Test: `scripts/take-writer/src/tools.test.ts`

`tools.ts` exposes the Anthropic tool schema and a `dispatchTool` that runs the drill-down, registers every source it returns into the ledger, and returns a compact JSON result string for the agent. Registering on dispatch is what guarantees the writer can only cite retrieved sources.

- [ ] **Step 1: Write failing tests**

`scripts/take-writer/src/tools.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { TOOL_DEFS, dispatchTool } from "./tools.js";
import { CitationLedger } from "./ledger.js";

describe("TOOL_DEFS", () => {
  it("declares the expected tools with input schemas", () => {
    const names = TOOL_DEFS.map((t) => t.name).sort();
    expect(names).toEqual(
      ["align_events", "follow_peer", "news_detail", "report_line", "search_news", "zoom_window"].sort(),
    );
    for (const t of TOOL_DEFS) {
      expect(t.input_schema.type).toBe("object");
    }
  });
});

describe("dispatchTool", () => {
  it("runs search_news and registers each returned source in the ledger", async () => {
    const ledger = new CitationLedger();
    const pg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "1", date: "2026-05-01", source: "Stockhead", headline: "Probe", url: "https://x/1" }],
      }),
    };
    const out = await dispatchTool(pg, ledger, "search_news", { query: "probe", code: "DRO" });
    expect(ledger.size()).toBe(1);
    expect(ledger.has("ref-1")).toBe(true);
    // The agent-facing result embeds the refId so the model can cite it.
    expect(out).toContain("ref-1");
    expect(out).toContain("Probe");
  });

  it("returns an error string for an unknown tool instead of throwing", async () => {
    const ledger = new CitationLedger();
    const pg = { query: vi.fn() };
    const out = await dispatchTool(pg, ledger, "nope", {});
    expect(out.toLowerCase()).toContain("unknown tool");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/take-writer && npx vitest run src/tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool registry**

`scripts/take-writer/src/tools.ts`:

```typescript
// Anthropic tool registry for the investigation agent. Each tool wraps
// a drill-down query. dispatchTool registers every source the tool
// surfaces into the citation ledger (handing back stable refIds) so the
// writer can cite only what was actually retrieved.

import type Anthropic from "@anthropic-ai/sdk";
import type { CitationLedger, LedgerSource } from "./ledger.js";
import {
  zoomWindow, reportLine, followPeer, alignEvents, newsDetail, searchNews,
  type Queryable,
} from "./drilldowns.js";

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "zoom_window",
    description: "Zoom into the short %, price, and news in a +/- day window around a specific date — use to investigate a spike or a price move you noticed in the summary.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Centre date YYYY-MM-DD" },
        days: { type: "number", description: "Half-window in days (e.g. 3)" },
      },
      required: ["date"],
    },
  },
  {
    name: "report_line",
    description: "Pull one reported financial metric (revenue, ebitda, eps, dividend, guidance, cash_flow, net_profit) from the company's most recent filings. Returns the value and a citable source.",
    input_schema: {
      type: "object",
      properties: { metric: { type: "string", description: "Metric key, e.g. 'revenue'" } },
      required: ["metric"],
    },
  },
  {
    name: "follow_peer",
    description: "Pull a named sector peer's short %/price history to compare divergence against the subject stock.",
    input_schema: {
      type: "object",
      properties: { peerCode: { type: "string" }, days: { type: "number" } },
      required: ["peerCode"],
    },
  },
  {
    name: "align_events",
    description: "Return a merged timeline of director trades and price-sensitive news for the subject, newest first — use to align director activity against price/short moves.",
    input_schema: { type: "object", properties: { days: { type: "number" } } },
  },
  {
    name: "news_detail",
    description: "Fetch the full record (summary, sentiment, url) for one news article by its id.",
    input_schema: {
      type: "object",
      properties: { articleId: { type: "string" } },
      required: ["articleId"],
    },
  },
  {
    name: "search_news",
    description: "Keyword-search recent news headlines/summaries (optionally scoped to a stock code) to find a specific thread.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, code: { type: "string" } },
      required: ["query"],
    },
  },
];

/** Register a source and return "[refId] headline (source, date)" for the agent. */
function cite(ledger: CitationLedger, s: LedgerSource): string {
  const refId = ledger.register(s);
  return `[${refId}] ${s.headline} (${s.source}, ${s.date})`;
}

export async function dispatchTool(
  pg: Queryable,
  ledger: CitationLedger,
  name: string,
  input: Record<string, unknown>,
  subjectCode?: string,
): Promise<string> {
  try {
    switch (name) {
      case "zoom_window": {
        const code = subjectCode ?? String(input.code ?? "");
        const w = await zoomWindow(pg, code, String(input.date), Number(input.days ?? 3));
        const newsLines = w.news.map((n) => cite(ledger, { type: "news", url: n.url, source: n.source, headline: n.headline, date: n.date }));
        return JSON.stringify({
          shorts: w.shorts, prices: w.prices,
          news: newsLines,
        });
      }
      case "report_line": {
        const code = subjectCode ?? String(input.code ?? "");
        const r = await reportLine(pg, code, String(input.metric));
        if (!r) return JSON.stringify({ found: false });
        const ref = cite(ledger, r.source);
        return JSON.stringify({ found: true, value: r.value, reportType: r.reportType, date: r.reportDate, citation: ref });
      }
      case "follow_peer": {
        const r = await followPeer(pg, String(input.peerCode), Number(input.days ?? 180));
        return JSON.stringify(r);
      }
      case "align_events": {
        const code = subjectCode ?? String(input.code ?? "");
        const items = await alignEvents(pg, code, Number(input.days ?? 180));
        return JSON.stringify(items.map((it) => ({ date: it.date, kind: it.kind, detail: it.detail, citation: cite(ledger, it.source) })));
      }
      case "news_detail": {
        const r = await newsDetail(pg, String(input.articleId));
        if (!r) return JSON.stringify({ found: false });
        const ref = cite(ledger, r.ledgerSource);
        return JSON.stringify({ found: true, headline: r.headline, summary: r.summary, sentiment: r.sentiment, date: r.date, citation: ref });
      }
      case "search_news": {
        const items = await searchNews(pg, String(input.query), input.code ? String(input.code) : subjectCode);
        return JSON.stringify(items.map((it) => ({ id: it.id, citation: cite(ledger, it.ledgerSource) })));
      }
      default:
        return `ERROR: unknown tool "${name}"`;
    }
  } catch (err) {
    return `ERROR running ${name}: ${String((err as Error).message ?? err).slice(0, 200)}`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/take-writer && npx vitest run src/tools.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/src/tools.ts scripts/take-writer/src/tools.test.ts
git commit -m "feat(take-writer): anthropic tool registry + ledger-registering dispatch"
```

---

## Task 6: journalism.ts — signal board + last-take lookup

**Files:**
- Modify: `scripts/take-writer/src/journalism.ts`
- Test: `scripts/take-writer/src/signalboard.test.ts`

- [ ] **Step 1: Write failing tests**

`scripts/take-writer/src/signalboard.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { lastTakeDateForStock } from "./journalism.js";

describe("lastTakeDateForStock", () => {
  it("returns the most recent created_at for a stock, or null", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ last: "2026-05-20" }] }) } as any;
    expect(await lastTakeDateForStock(pg, "BHP")).toBe("2026-05-20");
  });
  it("returns null when no take exists", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    expect(await lastTakeDateForStock(pg, "BHP")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/take-writer && npx vitest run src/signalboard.test.ts`
Expected: FAIL — `lastTakeDateForStock` not exported.

- [ ] **Step 3: Add the functions to journalism.ts**

Append to `scripts/take-writer/src/journalism.ts` (after `buildReport`):

```typescript
// --- Newsroom helpers ---

/** Most recent editorial_takes.created_at for a stock (YYYY-MM-DD), or null. */
export async function lastTakeDateForStock(
  pg: PgClient,
  code: string,
): Promise<string | null> {
  const { rows } = await pg.query<{ last: string | null }>(
    `SELECT to_char(MAX(created_at), 'YYYY-MM-DD') AS last
     FROM editorial_takes WHERE stock_code = $1`,
    [code],
  );
  return rows[0]?.last ?? null;
}

export interface SignalBoardRow {
  stockCode: string;
  name: string | null;
  industry: string | null;
  signals: Signals;
  lastTakeDate: string | null;
  recentPriceSensitiveHeadlines: Array<{ date: string; headline: string }>;
}

/**
 * Build a compact per-stock board for the editor agent: signals +
 * when we last covered the stock + the few most recent price-sensitive
 * headlines (so the editor can judge novelty). Pool comes from
 * mv_top_shorts (most-shorted first).
 */
export async function buildSignalBoard(
  pg: PgClient,
  poolSize = 30,
): Promise<SignalBoardRow[]> {
  const { rows } = await pg.query<{ product_code: string }>(
    `SELECT product_code FROM mv_top_shorts ORDER BY current_percent DESC LIMIT $1`,
    [poolSize],
  );
  const board: SignalBoardRow[] = [];
  for (const r of rows) {
    const code = r.product_code;
    const report = await buildReport(pg, code);
    const lastTakeDate = await lastTakeDateForStock(pg, code);
    board.push({
      stockCode: code,
      name: report.bundle.meta.name,
      industry: report.bundle.meta.industry,
      signals: report.signals,
      lastTakeDate,
      recentPriceSensitiveHeadlines: report.bundle.news
        .filter((a) => a.isPriceSensitive)
        .slice(0, 5)
        .map((a) => ({ date: a.publishedAt.slice(0, 10), headline: a.headline })),
    });
  }
  return board;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/take-writer && npx vitest run src/signalboard.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/src/journalism.ts scripts/take-writer/src/signalboard.test.ts
git commit -m "feat(take-writer): signal board + last-take lookup for the editor"
```

---

## Task 7: Editor agent + novelty gate

**Files:**
- Create: `scripts/take-writer/src/editor.ts`
- Test: `scripts/take-writer/src/editor.test.ts`

The novelty gate is a pure function tested directly; the Claude call (ranking + tier assignment) is wrapped so the pure gate filters its output too.

- [ ] **Step 1: Write failing tests**

`scripts/take-writer/src/editor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hasNewDevelopment } from "./editor.js";
import type { SignalBoardRow } from "./journalism.js";

const baseRow = (over: Partial<SignalBoardRow> = {}): SignalBoardRow => ({
  stockCode: "BHP",
  name: "BHP",
  industry: "Materials",
  lastTakeDate: "2026-05-20",
  recentPriceSensitiveHeadlines: [],
  signals: {
    shortSlope90d: 0, shortSlope30d: 0, shortSlope7d: 0,
    currentShortPct: 5, shortPct90dAvg: 5, shortPctChange90d: 0,
    shortPctMaxIn90d: 6, shortPctMinIn90d: 4,
    currentPrice: 40, priceChange1m: 0, priceChange3m: 0, priceChange6m: 0, priceChange12m: 0,
    priceShortsCorrelation30d: 0,
    newsArticlesLast30d: 0, newsArticlesLast7d: 0, priceSensitiveLast30d: 0,
    sentimentMix: { positive: 0, negative: 0, neutral: 0 }, sentimentTrendLast30d: "n/a",
    directorTradesLast90d: 0, directorNetValueLast90d: 0, directorMostRecentDate: null,
    peerSectorAverageShort: 5, peerRelative: "at", topRecentEvents: [],
  },
  ...over,
});

describe("hasNewDevelopment", () => {
  it("is true when never covered before", () => {
    expect(hasNewDevelopment(baseRow({ lastTakeDate: null }))).toBe(true);
  });

  it("is true when a price-sensitive headline landed after the last take", () => {
    const row = baseRow({
      lastTakeDate: "2026-05-20",
      recentPriceSensitiveHeadlines: [{ date: "2026-05-25", headline: "ASIC probe" }],
    });
    expect(hasNewDevelopment(row)).toBe(true);
  });

  it("is true on a short-position regime change since the last take", () => {
    const row = baseRow({ lastTakeDate: "2026-05-20", signals: { ...baseRow().signals, shortPctChange90d: 3.5 } });
    expect(hasNewDevelopment(row)).toBe(true);
  });

  it("is true on a fresh director trade after the last take", () => {
    const row = baseRow({ lastTakeDate: "2026-05-20", signals: { ...baseRow().signals, directorMostRecentDate: "2026-05-28" } });
    expect(hasNewDevelopment(row)).toBe(true);
  });

  it("is false when nothing material happened since the last take", () => {
    expect(hasNewDevelopment(baseRow())).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/take-writer && npx vitest run src/editor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the editor**

`scripts/take-writer/src/editor.ts`:

```typescript
// Editor agent — the assignment desk. Reads the day's signal board,
// applies a novelty gate (don't re-cover a stock without a new
// development), and asks Claude to commission the day's stories with an
// angle and a tier (take | deep_dive).

import Anthropic from "@anthropic-ai/sdk";
import type { Client as PgClient } from "pg";
import { buildSignalBoard, type SignalBoardRow } from "./journalism.js";

export interface Assignment {
  stockCode: string;
  angle: string;
  tier: "take" | "deep_dive";
  rationale: string;
}

export interface EditorOptions {
  poolSize?: number;
  maxTakes?: number;
  maxDeepDives?: number;
  model?: string;
}

const SHORT_REGIME_CHANGE_PCT = 2.0; // |current - 90d avg| beyond this = regime change

/**
 * Pure novelty gate. A stock is worth covering if it has never been
 * covered, OR something material happened after the last take:
 *  - a price-sensitive headline dated after lastTakeDate
 *  - a short-position regime change (|shortPctChange90d| >= threshold)
 *  - a director trade dated after lastTakeDate
 */
export function hasNewDevelopment(row: SignalBoardRow): boolean {
  if (!row.lastTakeDate) return true;
  const since = row.lastTakeDate;
  if (row.recentPriceSensitiveHeadlines.some((h) => h.date > since)) return true;
  if (Math.abs(row.signals.shortPctChange90d ?? 0) >= SHORT_REGIME_CHANGE_PCT) return true;
  if (row.signals.directorMostRecentDate && row.signals.directorMostRecentDate > since) return true;
  return false;
}

const EDITOR_SYSTEM = `You are the editor of Shorted, an ASX short-position
publication. From the signal board, commission the day's stories. Be
selective — only stories with a genuine angle a reader would click.

For each story pick:
- angle: one sharp sentence naming what the story IS (not a headline).
- tier: "deep_dive" only when there is a rich, multi-thread story worth
  600-1200 words (a probe with a timeline, a director-vs-data divergence,
  a sector unwind). Otherwise "take".

Return STRICT JSON: {"assignments":[{"stockCode","angle","tier","rationale"}]}.
No prose outside the JSON.`;

export async function commissionAssignments(
  pg: PgClient,
  opts: EditorOptions = {},
): Promise<Assignment[]> {
  const maxTakes = opts.maxTakes ?? 10;
  const maxDeepDives = opts.maxDeepDives ?? 2;
  const model = opts.model ?? process.env.EDITOR_MODEL ?? "claude-sonnet-4-6";

  const board = await buildSignalBoard(pg, opts.poolSize ?? 30);
  const fresh = board.filter(hasNewDevelopment);
  if (fresh.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });

  const boardText = fresh.map((r) => {
    const s = r.signals;
    return [
      `${r.stockCode} (${r.name ?? "?"}, ${r.industry ?? "?"})`,
      `  short ${s.currentShortPct?.toFixed(1)}% (Δ90d ${s.shortPctChange90d?.toFixed(1)}), price 3m ${s.priceChange3m?.toFixed(0)}%, corr ${s.priceShortsCorrelation30d?.toFixed(2)}`,
      `  news30d ${s.newsArticlesLast30d} (ps ${s.priceSensitiveLast30d}), sentiment ${s.sentimentTrendLast30d}, director net A$${s.directorNetValueLast90d.toFixed(0)}`,
      `  last covered: ${r.lastTakeDate ?? "never"}; recent price-sensitive: ${r.recentPriceSensitiveHeadlines.map((h) => `${h.date} ${h.headline}`).join(" | ") || "none"}`,
    ].join("\n");
  }).join("\n\n");

  const resp = await client.messages.create({
    model,
    max_tokens: 2000,
    system: EDITOR_SYSTEM,
    messages: [{
      role: "user",
      content: `Signal board (${fresh.length} stocks with a new development):\n\n${boardText}\n\nCommission up to ${maxTakes} takes and ${maxDeepDives} deep-dives. Return the JSON now.`,
    }],
  });

  const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  let parsed: { assignments?: Assignment[] };
  try { parsed = JSON.parse(jsonMatch[0]); } catch { return []; }
  const all = (parsed.assignments ?? []).filter((a) => a.stockCode && (a.tier === "take" || a.tier === "deep_dive"));

  // Enforce caps defensively (the model may over-commission).
  const deepDives = all.filter((a) => a.tier === "deep_dive").slice(0, maxDeepDives);
  const takes = all.filter((a) => a.tier === "take").slice(0, maxTakes);
  return [...deepDives, ...takes].map((a) => ({ ...a, stockCode: a.stockCode.toUpperCase() }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/take-writer && npx vitest run src/editor.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/src/editor.ts scripts/take-writer/src/editor.test.ts
git commit -m "feat(take-writer): editor agent with novelty gate + tiered assignments"
```

---

## Task 8: Investigation agent

**Files:**
- Create: `scripts/take-writer/src/investigator.ts`
- Test: `scripts/take-writer/src/investigator.test.ts`

The agentic loop is driven by an injected "messages.create"-shaped function so the loop logic (tool dispatch, turn cap, dossier finalisation) is testable without a live API.

- [ ] **Step 1: Write failing tests**

`scripts/take-writer/src/investigator.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { investigate, type MessagesCreate } from "./investigator.js";
import { CitationLedger } from "./ledger.js";

const assignment = { stockCode: "DRO", angle: "Probe vs shorts", tier: "take" as const, rationale: "x" };

describe("investigate", () => {
  it("runs a tool round then finalises the dossier from emit_dossier", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ id: "1", date: "2026-05-01", source: "S", headline: "Probe opened", url: "https://x/1" }] }) };
    const create: MessagesCreate = vi.fn()
      // round 1: call a tool
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "search_news", input: { query: "probe" } }],
      })
      // round 2: emit the dossier via the emit_dossier tool
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "emit_dossier", input: {
          summary: "ASIC opened a probe; shorts held.",
          threads: [{ claim: "Probe opened 1 May", evidenceRefIds: ["ref-1"] }],
          keyNumbers: [{ label: "short %", value: "14%" }],
        } }],
      });

    const ledger = new CitationLedger();
    const dossier = await investigate(create as MessagesCreate, pg, assignment, ledger, { maxTurns: 6, model: "claude-sonnet-4-6" });
    expect(dossier.summary).toContain("probe");
    expect(dossier.threads[0]!.evidenceRefIds).toEqual(["ref-1"]);
    expect(ledger.size()).toBe(1); // search_news registered the source
    expect((create as any).mock.calls.length).toBe(2);
  });

  it("finalises a minimal dossier if the turn cap is hit without emit_dossier", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const create: MessagesCreate = vi.fn().mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t", name: "align_events", input: {} }],
    });
    const ledger = new CitationLedger();
    const dossier = await investigate(create as MessagesCreate, pg, assignment, ledger, { maxTurns: 2, model: "claude-sonnet-4-6" });
    expect(dossier.stockCode).toBe("DRO");
    expect(Array.isArray(dossier.threads)).toBe(true);
    expect((create as any).mock.calls.length).toBe(2); // stopped at the cap
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/take-writer && npx vitest run src/investigator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the investigator**

`scripts/take-writer/src/investigator.ts`:

```typescript
// Investigation agent — the agentic core. Given an assignment, it runs
// Claude in a tool-calling loop over the drill-down tools, registering
// every retrieved source into the ledger, and finalises a structured
// Dossier via a special emit_dossier tool. Turn-capped; if the cap is
// hit before emit_dossier, we finalise with whatever was gathered.

import type Anthropic from "@anthropic-ai/sdk";
import type { Queryable } from "./drilldowns.js";
import type { CitationLedger } from "./ledger.js";
import { TOOL_DEFS, dispatchTool } from "./tools.js";
import type { Assignment } from "./editor.js";

export interface DossierThread { claim: string; evidenceRefIds: string[]; note?: string }
export interface DossierTimelineItem { date: string; event: string; refIds: string[] }
export interface DossierKeyNumber { label: string; value: string; refId?: string }
export interface Dossier {
  stockCode: string;
  tier: "take" | "deep_dive";
  angle: string;
  summary: string;
  threads: DossierThread[];
  timeline?: DossierTimelineItem[];
  keyNumbers: DossierKeyNumber[];
}

/** The subset of Anthropic's client.messages.create we depend on. */
export type MessagesCreate = (body: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export interface InvestigateOptions {
  maxTurns?: number;
  model: string;
  maxTokens?: number;
}

const EMIT_DOSSIER_TOOL: Anthropic.Tool = {
  name: "emit_dossier",
  description: "Call this ONCE when your investigation is complete to hand off your findings. Cite evidence ONLY by the refIds returned to you by other tools.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "2-3 sentence neutral summary of what you found." },
      threads: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            evidenceRefIds: { type: "array", items: { type: "string" } },
            note: { type: "string" },
          },
          required: ["claim", "evidenceRefIds"],
        },
      },
      timeline: {
        type: "array",
        items: {
          type: "object",
          properties: { date: { type: "string" }, event: { type: "string" }, refIds: { type: "array", items: { type: "string" } } },
          required: ["date", "event"],
        },
      },
      keyNumbers: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, value: { type: "string" }, refId: { type: "string" } },
          required: ["label", "value"],
        },
      },
    },
    required: ["summary", "threads", "keyNumbers"],
  },
};

function systemPrompt(a: Assignment): string {
  return `You are an investigative reporter for Shorted (ASX short positions).
Assignment: ${a.stockCode} — ${a.angle}
Tier: ${a.tier} (${a.tier === "deep_dive" ? "rich, multi-thread; build a timeline" : "tight, single sharp thread"}).

Investigate using the tools. Drill into spikes, follow peers, align
director trades to price, pull reported numbers. Every factual claim in
your dossier MUST be backed by a refId a tool returned to you — do not
invent sources or numbers. When done, call emit_dossier exactly once.
Keep it to ${a.tier === "deep_dive" ? "at most 10" : "at most 4"} investigative tool calls before emitting.`;
}

export async function investigate(
  create: MessagesCreate,
  pg: Queryable,
  assignment: Assignment,
  ledger: CitationLedger,
  opts: InvestigateOptions,
): Promise<Dossier> {
  const maxTurns = opts.maxTurns ?? (assignment.tier === "deep_dive" ? 14 : 6);
  const tools = [...TOOL_DEFS, EMIT_DOSSIER_TOOL];
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: `Begin your investigation of ${assignment.stockCode}. Angle: ${assignment.angle}.`,
  }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4000,
      system: systemPrompt(assignment),
      tools,
      messages,
    });

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) break; // model stopped without tools

    // Did it emit the dossier? Finalise.
    const emit = toolUses.find((t) => t.name === "emit_dossier");
    if (emit) {
      const input = emit.input as Partial<Dossier>;
      return finalise(assignment, input);
    }

    // Otherwise run the requested tools and feed results back.
    messages.push({ role: "assistant", content: resp.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const result = await dispatchTool(pg, ledger, t.name, t.input as Record<string, unknown>, assignment.stockCode);
      toolResults.push({ type: "tool_result", tool_use_id: t.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Turn cap hit without emit_dossier — finalise minimally with what's gathered.
  return finalise(assignment, {});
}

function finalise(assignment: Assignment, input: Partial<Dossier>): Dossier {
  return {
    stockCode: assignment.stockCode,
    tier: assignment.tier,
    angle: assignment.angle,
    summary: input.summary ?? assignment.angle,
    threads: input.threads ?? [],
    timeline: input.timeline,
    keyNumbers: input.keyNumbers ?? [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/take-writer && npx vitest run src/investigator.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/src/investigator.ts scripts/take-writer/src/investigator.test.ts
git commit -m "feat(take-writer): claude agentic investigation loop -> dossier"
```

---

## Task 9: Writer — dossier-aware narrative + WRITER_MODEL

**Files:**
- Modify: `scripts/take-writer/src/narrative.ts`
- Test: `scripts/take-writer/src/dossierwriter.test.ts`

Add a `synthesiseFromDossier` path. It builds the writer prompt from the dossier + ledger, calls Gemini (model from `WRITER_MODEL`), then runs `compactCitations` to drop any invented marker and produce the final `Citation[]`. The legacy `synthesiseNarrative` is untouched.

- [ ] **Step 1: Write failing tests for the pure prompt-builder + body assembler**

`scripts/take-writer/src/dossierwriter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildDossierPrompt, assembleTakeBody, assembleDeepDiveBody } from "./narrative.js";
import { CitationLedger } from "./ledger.js";
import type { Dossier } from "./investigator.js";

const ledger = new CitationLedger();
const r1 = ledger.register({ type: "news", url: "https://x/1", source: "S", headline: "Probe opened", date: "2026-05-01" });

const dossier: Dossier = {
  stockCode: "DRO", tier: "take", angle: "Probe vs shorts",
  summary: "ASIC opened a probe; shorts held.",
  threads: [{ claim: `Probe opened on 1 May [${r1}]`, evidenceRefIds: [r1] }],
  keyNumbers: [{ label: "short %", value: "14%", refId: r1 }],
};

describe("buildDossierPrompt", () => {
  it("lists ledger sources by refId so the writer can cite them", () => {
    const p = buildDossierPrompt(dossier, ledger);
    expect(p).toContain("ref-1");
    expect(p).toContain("Probe opened");
    expect(p).toContain("Probe vs shorts");
  });
});

describe("assembleTakeBody", () => {
  it("joins the four sections with blank lines", () => {
    const body = assembleTakeBody({ background: "a", recent_events: "b", the_data: "c", outlook: "d" });
    expect(body).toBe("a\n\nb\n\nc\n\nd");
  });
});

describe("assembleDeepDiveBody", () => {
  it("renders ## headings for each titled section", () => {
    const body = assembleDeepDiveBody([
      { heading: "The probe timeline", prose: "para one" },
      { heading: "What the shorts saw", prose: "para two" },
    ]);
    expect(body).toContain("## The probe timeline\n\npara one");
    expect(body).toContain("## What the shorts saw\n\npara two");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/take-writer && npx vitest run src/dossierwriter.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add the dossier writer to narrative.ts**

Add these exports to `scripts/take-writer/src/narrative.ts` (keep existing code; add imports for `CitationLedger`, `compactCitations`, and the `Dossier` type at the top):

```typescript
import { CitationLedger, compactCitations } from "./ledger.js";
import type { Dossier } from "./investigator.js";
```

Then append:

```typescript
// ---- Dossier-aware writer (investigative newsroom) ----

const WRITER_MODEL = () => process.env.WRITER_MODEL ?? "gemini-2.5-flash";
const WRITER_MODEL_DEEPDIVE = () => process.env.WRITER_MODEL_DEEPDIVE ?? WRITER_MODEL();

/** Build the writer prompt from a dossier + its ledger. The writer may
 *  only cite the refIds listed here. */
export function buildDossierPrompt(dossier: Dossier, ledger: CitationLedger): string {
  const sources: string[] = [];
  for (let i = 1; ledger.has(`ref-${i}`); i++) {
    const s = ledger.get(`ref-${i}`)!;
    sources.push(`[ref-${i}] (${s.date}, ${s.source}, ${s.type}): ${s.headline}`);
  }
  const threads = dossier.threads
    .map((t, i) => `${i + 1}. ${t.claim}${t.note ? ` — ${t.note}` : ""} (evidence: ${t.evidenceRefIds.join(", ") || "none"})`)
    .join("\n");
  const numbers = dossier.keyNumbers
    .map((n) => `- ${n.label}: ${n.value}${n.refId ? ` [${n.refId}]` : ""}`)
    .join("\n");
  const timeline = (dossier.timeline ?? [])
    .map((t) => `- ${t.date}: ${t.event} (${t.refIds.join(", ")})`)
    .join("\n");
  return [
    `Subject: ${dossier.stockCode}`,
    `Angle: ${dossier.angle}`,
    `Investigation summary: ${dossier.summary}`,
    "",
    "=== FINDINGS (threads) ===",
    threads || "(none)",
    "",
    "=== KEY NUMBERS ===",
    numbers || "(none)",
    timeline ? `\n=== TIMELINE ===\n${timeline}` : "",
    "",
    "=== CITABLE SOURCES (cite ONLY these refIds, inline as [ref-N]) ===",
    sources.join("\n") || "(none)",
  ].join("\n");
}

export function assembleTakeBody(s: { background: string; recent_events: string; the_data: string; outlook: string }): string {
  return [s.background, "", s.recent_events, "", s.the_data, "", s.outlook].join("\n");
}

export function assembleDeepDiveBody(sections: Array<{ heading: string; prose: string }>): string {
  return sections.map((s) => `## ${s.heading}\n\n${s.prose}`).join("\n\n");
}

export interface DossierTake {
  slug: string;
  headline: string;
  sentiment: "positive" | "negative" | "neutral";
  tier: "take" | "deep_dive";
  bodyMd: string;
  citations: Citation[];
  droppedCitations: string[];
}

const TAKE_DOSSIER_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    headline: { type: SchemaType.STRING },
    sentiment: { type: SchemaType.STRING, enum: ["positive", "negative", "neutral"] },
    background: { type: SchemaType.STRING },
    recent_events: { type: SchemaType.STRING },
    the_data: { type: SchemaType.STRING },
    outlook: { type: SchemaType.STRING },
  },
  required: ["headline", "sentiment", "background", "recent_events", "the_data", "outlook"],
};

const DEEPDIVE_DOSSIER_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    headline: { type: SchemaType.STRING },
    sentiment: { type: SchemaType.STRING, enum: ["positive", "negative", "neutral"] },
    sections: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: { heading: { type: SchemaType.STRING }, prose: { type: SchemaType.STRING } },
        required: ["heading", "prose"],
      },
    },
  },
  required: ["headline", "sentiment", "sections"],
};

/** Write a tiered Take from a grounded dossier. Cites only ledger refIds;
 *  compactCitations drops anything invented. */
export async function synthesiseFromDossier(
  dossier: Dossier,
  ledger: CitationLedger,
  stockCode: string,
): Promise<DossierTake> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const ai = new GoogleGenerativeAI(apiKey);
  const deep = dossier.tier === "deep_dive";
  const model = ai.getGenerativeModel({
    model: deep ? WRITER_MODEL_DEEPDIVE() : WRITER_MODEL(),
    systemInstruction: NARRATIVE_SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: deep ? DEEPDIVE_DOSSIER_SCHEMA : TAKE_DOSSIER_SCHEMA,
      temperature: 0.7,
      maxOutputTokens: deep ? 16000 : 8000,
    },
  });

  const prompt = [
    buildDossierPrompt(dossier, ledger),
    "",
    deep
      ? "Write a long-form investigation (600-1200 words). Derive 3-5 section headings from the findings. Cite [ref-N] inline wherever a fact comes from a source. Only cite refIds in CITABLE SOURCES."
      : "Write the four sections (background, recent_events, the_data, outlook). Cite [ref-N] inline. Only cite refIds in CITABLE SOURCES.",
  ].join("\n");

  let raw = "";
  let parsed: Record<string, unknown> = {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await model.generateContent(
      attempt === 1 ? prompt : prompt + `\n\nIMPORTANT: your previous draft used banned terms. Remove every one.`,
    );
    raw = resp.response.text();
    parsed = JSON.parse(raw);
    const proseForBan = deep
      ? (parsed.sections as Array<{ prose: string }> ?? []).map((s) => s.prose).join("\n") + "\n" + String(parsed.headline ?? "")
      : [parsed.background, parsed.recent_events, parsed.the_data, parsed.outlook, parsed.headline].join("\n");
    if (findBanned(proseForBan).length === 0) break;
  }

  const rawBody = deep
    ? assembleDeepDiveBody((parsed.sections as Array<{ heading: string; prose: string }>) ?? [])
    : assembleTakeBody({
        background: String(parsed.background ?? ""),
        recent_events: String(parsed.recent_events ?? ""),
        the_data: String(parsed.the_data ?? ""),
        outlook: String(parsed.outlook ?? ""),
      });

  const { body, citations, dropped } = compactCitations(rawBody, ledger);

  // Slug pass (reuse the existing low-temp slug model behaviour).
  const slugModel = ai.getGenerativeModel({ model: WRITER_MODEL(), generationConfig: { temperature: 0.2, maxOutputTokens: 500 } });
  const slugResp = await slugModel.generateContent(
    SLUG_PROMPT.replace("{{HEADLINE}}", String(parsed.headline ?? "")).replace("{{STOCK_CODE}}", stockCode),
  );
  const slug = slugResp.response.text().trim().toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

  return {
    slug,
    headline: String(parsed.headline ?? ""),
    sentiment: (parsed.sentiment as DossierTake["sentiment"]) ?? "neutral",
    tier: dossier.tier,
    bodyMd: body,
    citations,
    droppedCitations: dropped,
  };
}
```

> Note: `SLUG_PROMPT` is currently a module-local const in `narrative.ts` (defined at line ~146) — it is already in scope for this appended code. `findBanned`, `NARRATIVE_SYSTEM_PROMPT`, `SchemaType`, `GoogleGenerativeAI`, and `Citation` are all already defined/imported in the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/take-writer && npx vitest run src/dossierwriter.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck the package**

Run: `cd scripts/take-writer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/take-writer/src/narrative.ts scripts/take-writer/src/dossierwriter.test.ts
git commit -m "feat(take-writer): dossier-aware tiered writer (WRITER_MODEL), ledger-grounded citations"
```

---

## Task 10: Daily newsroom pipeline + validate-before-insert

**Files:**
- Modify: `scripts/take-writer/src/newsroom.ts`
- Test: `scripts/take-writer/src/publishguard.test.ts`

`runNewsroomDaily` wires editor → investigator → writer, applies model tiering, caps, and cost logging, and gates publishing through `shouldHoldAsDraft`.

- [ ] **Step 1: Write failing test for the publish guard**

`scripts/take-writer/src/publishguard.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { shouldHoldAsDraft } from "./newsroom.js";

describe("shouldHoldAsDraft", () => {
  it("holds when there are dropped (dangling) citations", () => {
    expect(shouldHoldAsDraft({ droppedCitations: ["ref-9"], citations: [{ refId: "ref-1" } as any] })).toBe(true);
  });
  it("holds a deep_dive with zero citations (ungrounded long-form)", () => {
    expect(shouldHoldAsDraft({ droppedCitations: [], citations: [], tier: "deep_dive" } as any)).toBe(true);
  });
  it("allows a clean grounded take through", () => {
    expect(shouldHoldAsDraft({ droppedCitations: [], citations: [{ refId: "ref-1" } as any], tier: "take" } as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/take-writer && npx vitest run src/publishguard.test.ts`
Expected: FAIL — `shouldHoldAsDraft` not exported.

- [ ] **Step 3: Add the guard + daily pipeline to newsroom.ts**

Add imports near the top of `scripts/take-writer/src/newsroom.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { commissionAssignments, type Assignment } from "./editor.js";
import { investigate } from "./investigator.js";
import { synthesiseFromDossier, type DossierTake } from "./narrative.js";
import { CitationLedger } from "./ledger.js";
```

Add the guard (exported, pure):

```typescript
/** Hold a piece as a draft (don't auto-publish) when grounding is weak:
 *  any dangling citation the writer invented, or a deep-dive with no
 *  citations at all. Never auto-publish ungrounded claims about a named
 *  company. */
export function shouldHoldAsDraft(t: { droppedCitations: string[]; citations: unknown[]; tier?: "take" | "deep_dive" }): boolean {
  if (t.droppedCitations.length > 0) return true;
  if (t.tier === "deep_dive" && t.citations.length === 0) return true;
  return false;
}
```

Add a tier-aware insert (extends the existing `insertTake`, adds `tier`):

```typescript
async function insertDossierTake(
  pg: PgClient,
  take: DossierTake,
  stockCode: string,
  heroUrl: string | null,
  inlineImages: InlineImageRow[],
  publish: boolean,
  writerModel: string,
): Promise<void> {
  const publishedClause = publish ? "NOW()" : "NULL";
  await pg.query(
    `INSERT INTO editorial_takes (
       slug, headline, stock_code, body_md, sentiment, word_count, model, tier,
       citations, hero_image_url, inline_images, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,${publishedClause})
     ON CONFLICT (slug) DO UPDATE SET
       headline=EXCLUDED.headline, body_md=EXCLUDED.body_md, tier=EXCLUDED.tier,
       sentiment=EXCLUDED.sentiment, word_count=EXCLUDED.word_count,
       citations=EXCLUDED.citations,
       hero_image_url=COALESCE(EXCLUDED.hero_image_url, editorial_takes.hero_image_url),
       inline_images=CASE WHEN jsonb_array_length(EXCLUDED.inline_images) > 0
                          THEN EXCLUDED.inline_images ELSE editorial_takes.inline_images END,
       updated_at=NOW()`,
    [
      take.slug, take.headline, stockCode, take.bodyMd, take.sentiment,
      take.bodyMd.split(/\s+/).filter(Boolean).length, writerModel, take.tier,
      JSON.stringify(take.citations), heroUrl, JSON.stringify(inlineImages),
    ],
  );
}
```

Add the daily runner:

```typescript
export interface DailyOptions {
  poolSize?: number;
  maxTakes?: number;
  maxDeepDives?: number;
  autoPublish: boolean;
  withImages: boolean;
}

export async function runNewsroomDaily(opts: DailyOptions): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  const takeModel = process.env.INVESTIGATOR_MODEL_TAKE ?? "claude-sonnet-4-6";
  const deepModel = process.env.INVESTIGATOR_MODEL_DEEPDIVE ?? "claude-opus-4-8";
  const maxTurnsTake = Number(process.env.MAX_TURNS_TAKE ?? 6);
  const maxTurnsDeep = Number(process.env.MAX_TURNS_DEEPDIVE ?? 14);

  const pg = new PgClient({ connectionString: dbUrl });
  await pg.connect();
  const client = new Anthropic({ apiKey: anthropicKey });
  const create = (body: Anthropic.MessageCreateParamsNonStreaming) => client.messages.create(body) as Promise<Anthropic.Message>;

  let openai: OpenAI | null = null;
  let storage: Storage | null = null;
  if (opts.withImages) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set (required for --with-images)");
    openai = new OpenAI({ apiKey: key });
    storage = new Storage();
  }

  let totalCost = 0;
  let published = 0, drafted = 0, held = 0, failed = 0;

  try {
    console.log(`\n[newsroom-daily] commissioning (pool ${opts.poolSize ?? 30}, ≤${opts.maxTakes ?? 10} takes, ≤${opts.maxDeepDives ?? 2} deep-dives)…`);
    const assignments = await commissionAssignments(pg, {
      poolSize: opts.poolSize,
      maxTakes: opts.maxTakes,
      maxDeepDives: opts.maxDeepDives,
    });
    if (assignments.length === 0) {
      console.log("[newsroom-daily] nothing new to cover today.");
      return;
    }
    console.log(`[newsroom-daily] ${assignments.length} assignments:`);
    for (const a of assignments) console.log(`  - ${a.stockCode} [${a.tier}] ${a.angle}`);

    for (const [i, a] of assignments.entries()) {
      const tag = `[${i + 1}/${assignments.length}] ${a.stockCode}`;
      const t0 = Date.now();
      try {
        const ledger = new CitationLedger();
        const dossier = await investigate(create, pg, a, ledger, {
          model: a.tier === "deep_dive" ? deepModel : takeModel,
          maxTurns: a.tier === "deep_dive" ? maxTurnsDeep : maxTurnsTake,
        });
        const writerModel = a.tier === "deep_dive"
          ? (process.env.WRITER_MODEL_DEEPDIVE ?? process.env.WRITER_MODEL ?? "gemini-2.5-flash")
          : (process.env.WRITER_MODEL ?? "gemini-2.5-flash");
        const take = await synthesiseFromDossier(dossier, ledger, a.stockCode);
        console.log(`${tag} → "${take.headline}" (${take.citations.length} cites, ${take.droppedCitations.length} dropped)`);

        const hold = shouldHoldAsDraft(take);
        if (hold && opts.autoPublish) {
          console.warn(`${tag}   ⚠ holding as draft (grounding weak: dropped ${take.droppedCitations.join(",") || "none"})`);
        }
        const publishThis = opts.autoPublish && !hold;

        let heroUrl: string | null = null;
        let inlineImages: InlineImageRow[] = [];
        if (opts.withImages && openai && storage) {
          // Reuse the existing image helpers — they take an AgendaCandidate
          // shape; build the minimal shape they read (stockCode, industry).
          const candidate = { stockCode: a.stockCode, industry: null } as unknown as AgendaCandidate;
          const narrativeShim = { slug: take.slug, headline: take.headline } as unknown as NarrativeTake;
          const img = await generateHero(openai, storage, candidate, narrativeShim);
          heroUrl = img.url; totalCost += img.costUsd;
          const inl = await generateInlineImages(openai, storage, candidate, narrativeShim, 2);
          inlineImages = inl.images; totalCost += inl.costUsd;
        }

        await insertDossierTake(pg, take, a.stockCode, heroUrl, inlineImages, publishThis, writerModel);
        if (publishThis) published++;
        else if (hold) held++;
        else drafted++;
        console.log(`${tag}   ✓ ${publishThis ? "published" : "draft"} /news/${take.slug} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (err) {
        failed++;
        console.log(`${tag}   ✗ ${String((err as Error).message ?? err).slice(0, 160)}`);
      }
    }
  } finally {
    await pg.end();
  }

  console.log("\n=== Newsroom-daily briefing ===");
  console.log(`  published: ${published}  drafted: ${drafted}  held(weak grounding): ${held}  failed: ${failed}`);
  console.log(`  image cost: $${totalCost.toFixed(3)} (LLM token cost logged by providers)`);
}
```

> The image helpers (`generateHero`, `generateInlineImages`) read only `candidate.stockCode`, `candidate.industry`, `take.slug`, and `take.headline` — the shims above satisfy that. If a future change makes them read more fields, widen the shims.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/take-writer && npx vitest run src/publishguard.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck**

Run: `cd scripts/take-writer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/take-writer/src/newsroom.ts scripts/take-writer/src/publishguard.test.ts
git commit -m "feat(take-writer): daily editor->investigator->writer pipeline + publish guard"
```

---

## Task 11: CLI command `newsroom-daily`

**Files:**
- Modify: `scripts/take-writer/src/index.ts`

- [ ] **Step 1: Add the import**

In `scripts/take-writer/src/index.ts`, change the newsroom import to also pull the daily runner:

```typescript
import { runNewsroom } from "./newsroom.js";
import { runNewsroomDaily } from "./newsroom.js";
```

- [ ] **Step 2: Add the command to the switch**

In `main()`'s `switch (args.command)`, add a case after the existing `newsroom` case:

```typescript
    case "newsroom-daily": {
      const autoPublish = args.autoPublish ?? false;
      const withImages = args.withImages ?? (autoPublish && !args.noImages);
      await runNewsroomDaily({
        poolSize: args.poolSize,
        maxTakes: args.topN ?? Number(process.env.MAX_TAKES_PER_DAY ?? 10),
        maxDeepDives: Number(process.env.MAX_DEEPDIVES_PER_DAY ?? 2),
        autoPublish,
        withImages,
      });
      break;
    }
```

- [ ] **Step 3: Document it in `help()`**

In the `help()` Commands block, add the line after `newsroom`:

```
  newsroom-daily  Investigative daily run: editor → agentic investigation → tiered writer
```

- [ ] **Step 4: Typecheck**

Run: `cd scripts/take-writer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify help lists the command**

Run: `cd scripts/take-writer && npx tsx src/index.ts --help`
Expected: output includes `newsroom-daily`.

- [ ] **Step 6: Commit**

```bash
git add scripts/take-writer/src/index.ts
git commit -m "feat(take-writer): add newsroom-daily CLI command"
```

---

## Task 12: Terraform — daily Cloud Run Job + Scheduler

**Files:**
- Create: `terraform/modules/newsroom-job/main.tf`
- Create: `terraform/modules/newsroom-job/variables.tf`
- Create: `terraform/modules/newsroom-job/outputs.tf`
- Modify: `terraform/environments/dev/main.tf`

Follow the existing Cloud Run Job pattern (see project memory: module under `terraform/modules/`, SA + Secret Manager IAM, scheduler in `australia-southeast1`, `min_instance_count` not set on Jobs).

- [ ] **Step 1: variables.tf**

`terraform/modules/newsroom-job/variables.tf`:

```hcl
variable "project_id" { type = string }
variable "region" { type = string, default = "australia-southeast2" }
variable "scheduler_region" { type = string, default = "australia-southeast1" }
variable "image" { type = string, description = "Container image for the take-writer newsroom job" }
variable "schedule" { type = string, default = "0 20 * * *", description = "Cron (UTC) — default 06:00 AEST" }
variable "database_url_secret" { type = string, description = "Secret Manager secret id holding DATABASE_URL" }
variable "anthropic_key_secret" { type = string }
variable "gemini_key_secret" { type = string }
variable "openai_key_secret" { type = string }
variable "gcs_logo_bucket" { type = string, default = "shorted-company-logos" }
variable "max_takes_per_day" { type = string, default = "10" }
variable "max_deepdives_per_day" { type = string, default = "2" }
```

- [ ] **Step 2: main.tf**

`terraform/modules/newsroom-job/main.tf`:

```hcl
resource "google_service_account" "newsroom" {
  account_id   = "newsroom-job"
  display_name = "Newsroom daily job"
  project      = var.project_id
}

locals {
  secret_ids = [
    var.database_url_secret,
    var.anthropic_key_secret,
    var.gemini_key_secret,
    var.openai_key_secret,
  ]
}

resource "google_secret_manager_secret_iam_member" "newsroom_secrets" {
  for_each  = toset(local.secret_ids)
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.newsroom.email}"
}

resource "google_storage_bucket_iam_member" "newsroom_gcs" {
  bucket = var.gcs_logo_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.newsroom.email}"
}

resource "google_cloud_run_v2_job" "newsroom" {
  name     = "newsroom-daily"
  location = var.region
  project  = var.project_id

  template {
    template {
      service_account = google_service_account.newsroom.email
      timeout         = "1800s"
      max_retries     = 0

      containers {
        image = var.image
        # Entry: tsx src/index.ts newsroom-daily --auto-publish --with-images
        args = ["newsroom-daily", "--auto-publish", "--with-images"]

        resources {
          limits = { cpu = "2", memory = "2Gi" }
        }

        env {
          name  = "GCS_LOGO_BUCKET"
          value = var.gcs_logo_bucket
        }
        env {
          name  = "MAX_TAKES_PER_DAY"
          value = var.max_takes_per_day
        }
        env {
          name  = "MAX_DEEPDIVES_PER_DAY"
          value = var.max_deepdives_per_day
        }
        dynamic "env" {
          for_each = {
            DATABASE_URL      = var.database_url_secret
            ANTHROPIC_API_KEY = var.anthropic_key_secret
            GEMINI_API_KEY    = var.gemini_key_secret
            OPENAI_API_KEY    = var.openai_key_secret
          }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
}

# Cloud Scheduler must live in australia-southeast1 (no southeast2 scheduler).
resource "google_service_account" "scheduler" {
  account_id   = "newsroom-scheduler"
  display_name = "Newsroom scheduler invoker"
  project      = var.project_id
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoke" {
  name     = google_cloud_run_v2_job.newsroom.name
  location = var.region
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "newsroom_daily" {
  name     = "newsroom-daily"
  project  = var.project_id
  region   = var.scheduler_region
  schedule = var.schedule

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.newsroom.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}
```

- [ ] **Step 3: outputs.tf**

`terraform/modules/newsroom-job/outputs.tf`:

```hcl
output "job_name" { value = google_cloud_run_v2_job.newsroom.name }
output "service_account_email" { value = google_service_account.newsroom.email }
```

- [ ] **Step 4: Wire into the dev environment**

Append to `terraform/environments/dev/main.tf` (adjust secret ids/image var to match the env's existing naming — grep the file for an existing `google_secret_manager_secret` or job module to copy the exact secret resource ids):

```hcl
module "newsroom_job" {
  source = "../../modules/newsroom-job"

  project_id           = var.project_id
  image                = "${var.region}-docker.pkg.dev/${var.project_id}/shorted/take-writer:latest"
  database_url_secret  = "DATABASE_URL"
  anthropic_key_secret = "ANTHROPIC_API_KEY"
  gemini_key_secret    = "GEMINI_API_KEY"
  openai_key_secret    = "OPENAI_API_KEY"
}
```

- [ ] **Step 5: Validate the module formatting**

Run: `cd terraform/modules/newsroom-job && terraform fmt && terraform validate || echo "validate needs 'terraform init' + GCP creds — fmt is the local gate"`
Expected: `terraform fmt` rewrites nothing (or formats cleanly); validate may require init/creds per project memory — fmt passing is the local gate.

- [ ] **Step 6: Commit**

```bash
git add terraform/modules/newsroom-job/ terraform/environments/dev/main.tf
git commit -m "feat(infra): daily newsroom Cloud Run Job + scheduler (southeast1)"
```

> **Manual prerequisite (note for the operator, not a code step):** create the `ANTHROPIC_API_KEY` secret in Secret Manager before `terraform apply`. The `take-writer:latest` image must be built/pushed (the job's Dockerfile/CI is an existing-pattern follow-up if `scripts/take-writer` isn't yet containerised — flag to the user; out of scope for this plan if no Dockerfile exists).

---

## Task 13: End-to-end dry run + full test suite

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `cd scripts/take-writer && npm test`
Expected: all test files pass (ledger, drilldowns, tools, signalboard, editor, investigator, dossierwriter, publishguard).

- [ ] **Step 2: Typecheck the whole package**

Run: `cd scripts/take-writer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Live dry run against the dev DB (drafts, no publish, no images)**

Requires `DATABASE_URL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` in the repo-root `.env`. Run:

`cd scripts/take-writer && npx tsx src/index.ts newsroom-daily --top=2 --no-images`
Expected: editor commissions ≤2 assignments; each investigates (tool calls logged) and drafts a Take; briefing prints `drafted: N`. No rows published (published=0).

- [ ] **Step 4: Inspect a drafted row + verify grounding**

Run:
```bash
psql postgresql://admin:password@localhost:5438/shorts -c \
  "SELECT slug, tier, jsonb_array_length(citations) AS cites, word_count FROM editorial_takes ORDER BY created_at DESC LIMIT 2;"
```
Expected: rows with `tier` set, `cites >= 1`, sensible `word_count`. Spot-check one body: every `[ref-N]` in `body_md` has a matching entry in `citations` (the compaction guarantee).

- [ ] **Step 5: Commit any fixes found during the dry run**

If the dry run surfaced issues, fix them, re-run steps 1-4, then commit:

```bash
git add -A
git commit -m "fix(take-writer): newsroom-daily dry-run fixes"
```

---

## Self-Review

**Spec coverage:**
- Editor agent + novelty gate → Task 7 ✓
- Agentic investigation loop with data tools → Tasks 4, 5, 8 ✓
- Incremental drill-downs (not re-fetches) → Task 4 ✓
- Citation ledger + writer-cites-only-retrieved + validate-before-insert → Tasks 3, 9, 10 ✓
- Tiered output (take vs deep_dive) → Tasks 7, 9 ✓
- Writer stays Gemini, `WRITER_MODEL` configurable + `gemini-3.5-preview` opt-in → Task 9 ✓
- Model tiering (Sonnet editor/take, Opus deep-dive) → Task 10 ✓
- Cost caps (turns, stories, model tier) → Tasks 7, 8, 10, 11 ✓
- Schema `tier` column → Task 2 ✓
- Scheduling (Cloud Run Job + Scheduler southeast1, no min-instance) → Task 12 ✓
- Existing image-gen + draft/publish/tweet pipeline reused → Task 10 ✓
- Out of scope: frontend rich rendering (SP2) — correctly absent ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; tests have real assertions.

**Type consistency:** `Assignment` defined in `editor.ts`, imported by `investigator.ts`/`newsroom.ts`. `Dossier` defined in `investigator.ts`, imported by `narrative.ts`. `LedgerSource`/`CitationLedger`/`compactCitations` in `ledger.ts`. `Citation` reused from `narrative.ts` (type `"news"|"trade"|"data"|"report"` — ledger maps `"director"`→`"trade"`, verified in Task 3 impl). `Queryable` in `drilldowns.ts` reused by `tools.ts`/`investigator.ts`. `DossierTake` defined in `narrative.ts`, consumed in `newsroom.ts`. Function names consistent: `commissionAssignments`, `investigate`, `synthesiseFromDossier`, `compactCitations`, `shouldHoldAsDraft`, `buildSignalBoard`, `lastTakeDateForStock`.

**Known follow-ups flagged (not gaps):** containerising `scripts/take-writer` (Dockerfile/CI) for the Cloud Run Job image, and creating the `ANTHROPIC_API_KEY` secret — both noted in Task 12 as operator prerequisites.
