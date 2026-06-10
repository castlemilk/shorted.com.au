# Newsroom Uplift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Shorted newsroom into a deduplicated, MDX-powered digital masthead: data-journalism articles with embedded live charts, a newspaper-grade front page, topical photojournalistic heroes, and a `newsroom` skill codifying the operating loop.

**Architecture:** Five phases matching the spec (`docs/superpowers/specs/2026-06-10-newsroom-uplift-design.md`): (1) wire-feed dedup using the existing cluster machinery, (2) MDX foundation (DB → proto → renderer → compile gate), (3) writer/investigator data spine, (4) masthead UI, (5) image uplift, (6) skill doc. The existing pipeline (editor→investigator→writer→art-director→validator) and grounding model are preserved.

**Tech Stack:** Go (news-aggregator, shorts service), Connect-RPC + protobuf v2 (`buf generate`), TypeScript (take-writer, vitest), Next.js 14 + `next-mdx-remote` + zod + visx + shadcn, gpt-image-2, Gemini 3.5 Flash.

**Conventions (apply to every task):**
- Branch: `feat/investigative-newsroom`. Commits use `--no-verify` (pre-existing frontend lint debt; see CLAUDE.md).
- Prod DB migrations: add the file to `services/migrations/` for the record, but apply to prod **via psql directly** with `IF NOT EXISTS` — never `make migrate-up` (schema_migrations drift, see spec).
- Go builds: `cd services && go build ./news-aggregator/... ./shorts/...`. TS: `cd scripts/take-writer && npm test`. Frontend: `cd web && npx tsc --noEmit`.
- Never import `@connectrpc/connect` into SSR-shared modules; chart components are client components loaded from the MDX map.

---

## Phase 1 — Dedup: cleanup & prevention

### Task 1: Run clustering inline after every aggregation run

**Files:**
- Modify: `services/news-aggregator/main.go` (end of `runAggregation`, after the cleanup block ~line 254)

- [ ] **Step 1: Add the inline clustering call**

In `runAggregation`, after the `cleanup_old_news_articles()` block and before the duration log, add:

```go
	// Cluster syndicated coverage (SMH/Age/WAtoday etc.) so the feed can
	// collapse duplicates. Inline so every run leaves the table clustered;
	// RUN_MODE=cluster-news remains for manual/backfill runs.
	if !dryRun {
		if err := ClusterNews(ctx, store.db, ClusterNewsOpts{}); err != nil {
			log.Printf("  WARNING: clustering failed: %v", err)
		}
	}
```

`ClusterNewsOpts{}` zero-values resolve to LookbackHours=48 / MinShingleOverlap=3 inside `ClusterNews` (clustering.go:42-47). `store.db` is the same `*pgxpool.Pool` already used for cleanup at main.go:249.

- [ ] **Step 2: Build**

Run: `cd services && go build ./news-aggregator/...`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add services/news-aggregator/main.go
git commit --no-verify -m "feat(news-aggregator): cluster syndicated coverage inline after every aggregation run"
```

### Task 2: Feed APIs return cluster primaries with syndication info

**Files:**
- Modify: `proto/shortedapi/shorts/v1alpha1/shorts.proto:1058-1071` (NewsArticle message)
- Modify: `services/shorts/internal/store/shorts/postgres_news.go`
- Modify: `services/shorts/internal/store/shorts/store.go` (NewsArticle struct — find `type NewsArticle struct`)
- Modify: the service handler mapping news rows → proto (grep `GetMarketNews` in `services/shorts/internal/services/shorts/`)
- Test: extend whatever `*_test.go` covers news store mapping; otherwise add `services/shorts/internal/store/shorts/postgres_news_test.go` is NOT needed (DB-bound) — service-level mapping test only if a mock pattern exists. Verification is build + manual query.

- [ ] **Step 1: Add proto fields**

In `message NewsArticle` (after `string image_url = 12;`):

```protobuf
  int32 syndication_count = 13;          // total articles in this story cluster (1 = unsyndicated)
  repeated string syndicated_sources = 14; // other mastheads carrying this story
```

- [ ] **Step 2: Regenerate protobuf**

Run: `cd proto && buf generate`
Then: `grep -r "MethodKind" web/src/gen/` — Expected: no results (protobuf v2 regression check).

- [ ] **Step 3: Update both store queries to primaries-only + syndication lateral**

In `postgres_news.go`, change both `GetStockNews` and `GetMarketNews` base queries to:

```go
	query := `SELECT n.id, n.stock_code, n.source, n.headline, n.url, n.published_at,
			n.sentiment, n.relevance_score, n.is_price_sensitive, n.summary, n.tags, n.image_url,
			COALESCE(c.cnt, 1) AS syndication_count,
			COALESCE(c.sources, '{}') AS syndicated_sources
		FROM news_articles n
		LEFT JOIN LATERAL (
			SELECT COUNT(*) AS cnt,
			       ARRAY_AGG(DISTINCT m.source) FILTER (WHERE m.id <> n.id) AS sources
			FROM news_articles m
			WHERE m.cluster_id = n.cluster_id
		) c ON n.cluster_id IS NOT NULL
		WHERE (n.cluster_id IS NULL OR n.cluster_is_primary = TRUE)`
```

(`GetStockNews` keeps `AND n.stock_code = $1`; the `source`/`sentiment`/`is_price_sensitive` filters and ORDER BY/LIMIT clauses gain the `n.` prefix.) Scan the two new columns:

```go
	var syndSources []string
	... rows.Scan(..., &a.ImageURL, &a.SyndicationCount, &syndSources)
	a.SyndicatedSources = syndSources
```

Add to the `NewsArticle` struct in `store.go`:

```go
	SyndicationCount  int32
	SyndicatedSources []string
```

- [ ] **Step 4: Map the new fields in the service handler**

Where the handler builds `*pb.NewsArticle` from the store row, add:

```go
	SyndicationCount:  a.SyndicationCount,
	SyndicatedSources: a.SyndicatedSources,
```

- [ ] **Step 5: Build + unit tests**

Run: `cd services && go build ./shorts/... && go test ./shorts/...`
Expected: build clean; existing tests pass (if a mock store interface lists news methods, signatures are unchanged — only the struct gained fields).

- [ ] **Step 6: Commit**

```bash
git add proto/ services/shorts/ web/src/gen/
git commit --no-verify -m "feat(news): feed returns cluster primaries only, with syndication count + sources"
```

### Task 3: Syndication chip in the news card + backfill

**Files:**
- Modify: `web/src/@/components/news/news-card.tsx` (NewsCardArticle type + source badge area)
- Modify: `web/src/app/news/page.tsx:60-99` (ApiArticle + toCardArticle)

- [ ] **Step 1: Thread syndication through the card**

`ApiArticle` gains `syndicationCount?: number; syndicatedSources?: string[];` and `toCardArticle` passes them through. In `news-card.tsx`, add to `NewsCardArticle`:

```ts
  syndicationCount?: number;
  syndicatedSources?: string[];
```

Next to the existing source badge render:

```tsx
{(article.syndicationCount ?? 1) > 1 && (
  <span
    className="text-[10px] uppercase tracking-wide text-muted-foreground"
    title={`Also covered by ${(article.syndicatedSources ?? []).join(", ")}`}
  >
    +{(article.syndicationCount ?? 1) - 1} source{(article.syndicationCount ?? 1) > 2 ? "s" : ""}
  </span>
)}
```

- [ ] **Step 2: Type check**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Backfill prod clusters (operational)**

```bash
cd services && DATABASE_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL --project=rosy-clover-477102-t5 --account=ben@shorted.com.au) \
RUN_MODE=cluster-news CLUSTER_LOOKBACK_HOURS=2160 go run ./news-aggregator/ --dry-run
```

Review the dry-run cluster log (expect the SMH/Age "Inflation is hair-raising…" pair grouped), then re-run **without** `--dry-run`. The 12h pair-gap inside `ClusterNews` still applies, so a 90-day lookback only merges same-day syndication.

- [ ] **Step 4: Update investigator news queries to prefer primaries**

In `scripts/take-writer/src/drilldowns.ts`, add `AND (cluster_id IS NULL OR cluster_is_primary = TRUE)` to the three `news_articles` WHERE clauses in `zoomWindow` (line ~45), `alignEvents` (line ~147), and `searchNews` (line ~195). Run `cd scripts/take-writer && npm test` — drilldown tests use a fake Queryable and assert results, not SQL text; expected pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/@/components/news/news-card.tsx web/src/app/news/page.tsx scripts/take-writer/src/drilldowns.ts
git commit --no-verify -m "feat(news): syndication chip on wire cards; investigator prefers cluster primaries"
```

---

## Phase 2 — MDX foundation

### Task 4: Migration 000041 + proto fields for MDX takes

**Files:**
- Create: `services/migrations/000041_editorial_takes_mdx.up.sql` / `.down.sql`
- Modify: `proto/shortedapi/shorts/v1alpha1/shorts.proto:1104-1124` (EditorialTake)
- Modify: Go store reading/writing editorial_takes (grep `FROM editorial_takes` under `services/shorts/internal/store/shorts/` — likely `postgres_takes.go`) + service mapping + `NewsArticle`-style struct.

- [ ] **Step 1: Write the migration**

`000041_editorial_takes_mdx.up.sql`:

```sql
-- MDX-powered editorial takes: body format discriminator + masthead fields.
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS body_format TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS standfirst TEXT;
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS byline TEXT;
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS hero_caption TEXT;
ALTER TABLE editorial_takes ADD COLUMN IF NOT EXISTS hero_credit TEXT;
COMMENT ON COLUMN editorial_takes.body_format IS 'markdown | mdx — render path discriminator';
```

`.down.sql` drops the five columns.

- [ ] **Step 2: Apply to prod via psql (NOT migrate-up)**

```bash
psql "$DATABASE_URL" -f services/migrations/000041_editorial_takes_mdx.up.sql
```

(DATABASE_URL from gcloud secrets as in Task 3.) Verify: `psql "$DATABASE_URL" -c "\d editorial_takes" | grep -E "body_format|standfirst|byline|hero_caption|hero_credit"` → 5 rows.

- [ ] **Step 3: Proto fields**

In `message EditorialTake` (after `repeated LayoutImage layout_images = 19;`):

```protobuf
  string body_format = 20;    // 'markdown' | 'mdx'
  string standfirst = 21;     // one-sentence dek under the headline
  string byline = 22;         // e.g. "The Shorted Desk — Mining & Resources"
  string hero_caption = 23;
  string hero_credit = 24;    // e.g. "AI-generated illustration"
```

Run `cd proto && buf generate`; check `grep -r "MethodKind" web/src/gen/` → empty.

- [ ] **Step 4: Go store + handler mapping**

In the editorial-takes store file: add the five columns to the SELECT lists of GetEditorialTake/ListEditorialTakes, scan into new struct fields (`BodyFormat, Standfirst, Byline, HeroCaption, HeroCredit string`, nullable scanned via `sql-null` pattern used by neighbouring fields — match file idiom, COALESCE in SQL is simplest: `COALESCE(standfirst,'')`). Map into the proto message in the service layer alongside existing fields.

- [ ] **Step 5: Build + test + commit**

Run: `cd services && go build ./shorts/... && go test ./shorts/...` → clean.

```bash
git add services/migrations/000041* proto/ services/shorts/ web/src/gen/
git commit --no-verify -m "feat(takes): body_format/standfirst/byline/hero caption+credit columns + proto"
```

### Task 5: MDX component registry (web)

**Files:**
- Create: `web/src/@/components/news/mdx/registry.tsx` (component map)
- Create: `web/src/@/components/news/mdx/manifest.ts` (palette manifest — names, prop schemas, usage)
- Create: `web/src/@/components/news/mdx/stat-group.tsx`, `pull-quote.tsx`, `figure.tsx`, `timeline.tsx`
- Create: `web/src/@/components/news/mdx/short-interest-chart.tsx`, `price-chart.tsx` (client components wrapping existing visx chart pieces — reuse the chart primitives already used on `/shorts/[code]`; grep `visx` under `web/src/@/components` and import the same building blocks)
- Test: `web/src/@/components/news/mdx/__tests__/manifest.test.ts`

- [ ] **Step 1: Manifest (single source of truth)**

`manifest.ts`:

```ts
import { z } from "zod";

const WINDOWS = ["1m", "3m", "6m", "1y"] as const;

export const MDX_COMPONENT_SCHEMAS = {
  ShortInterestChart: z.object({ code: z.string().regex(/^[A-Z0-9]{2,5}$/), window: z.enum(WINDOWS).default("6m") }),
  PriceChart: z.object({ code: z.string().regex(/^[A-Z0-9]{2,5}$/), window: z.enum(WINDOWS).default("6m") }),
  StatGroup: z.object({}),
  Stat: z.object({ label: z.string().min(1), value: z.string().min(1), context: z.string().optional(), cite: z.string().regex(/^ref-\d+$/).optional() }),
  PullQuote: z.object({}),
  Figure: z.object({ src: z.string().url(), caption: z.string().optional(), credit: z.string().optional(), placement: z.enum(["full", "left", "right", "inset"]).default("full") }),
  Timeline: z.object({}),
  TimelineEvent: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().min(1), cite: z.string().regex(/^ref-\d+$/).optional() }),
} as const;

export type MdxComponentName = keyof typeof MDX_COMPONENT_SCHEMAS;
export const MDX_COMPONENT_NAMES = Object.keys(MDX_COMPONENT_SCHEMAS) as MdxComponentName[];

/** Plain-JSON palette description injected into the writer prompt. */
export const MDX_PALETTE_DOC = `
<ShortInterestChart code="BHP" window="6m" /> — short interest vs price chart. One per article, after the data discussion.
<PriceChart code="BHP" window="3m" /> — price/volume only; use when price action is the story.
<StatGroup><Stat label="Short interest" value="12.4%" context="up 3.1pp in 90 days" cite="ref-2" /></StatGroup> — 2-4 key numbers, every value must appear in your sources or the provided data.
<PullQuote>One striking sentence from your own prose.</PullQuote>
<Timeline><TimelineEvent date="2026-04-02" label="CEO sells $1.2M" cite="ref-3" /></Timeline> — only for genuine sequences (3+ events).
Rules: components on their own lines, never inside markdown headings/lists; window one of 1m|3m|6m|1y; cite only [ref-N] ids from CITABLE SOURCES; no other components, no imports, no HTML.
`.trim();
```

- [ ] **Step 2: Presentational components**

`stat-group.tsx`, `pull-quote.tsx`, `figure.tsx`, `timeline.tsx` are server-safe presentational components (no connect imports), styled to the dark/amber theme with shadcn `cn()`. Complete `stat-group.tsx` as the pattern:

```tsx
import { cn } from "@/lib/utils";

export function StatGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-4">
      {children}
    </div>
  );
}

export function Stat({ label, value, context, cite }: { label: string; value: string; context?: string; cite?: string }) {
  return (
    <div className="bg-card p-4">
      <div className="font-mono text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {context && <div className={cn("mt-1 text-xs text-muted-foreground/80")}>{context}</div>}
      {cite && <sup className="text-[10px] text-primary">[{cite}]</sup>}
    </div>
  );
}
```

`PullQuote`: full-width blockquote, serif italic 2xl, amber left rule. `Figure`: `<figure>` with next/image, placement variants matching take-body's existing full/side classes, caption + credit line in muted small caps. `Timeline`: vertical rule with date-stamped events. Match the visual idiom in `take-body.tsx`.

- [ ] **Step 3: Chart components**

`short-interest-chart.tsx` / `price-chart.tsx`: `"use client"` components fetching via the **client** action path (`web/src/app/actions/client/` per project rules) with TanStack Query, rendering the same visx primitives used on `/shorts/[code]` (locate with `grep -rl "visx" web/src/@/components` and reuse the time-series chart component there with a compact height ~280px, amber/emerald series, dark axis styling). Loading state = shadcn `Skeleton`. On fetch error render `null` (article must never crash on a chart).

- [ ] **Step 4: Registry**

`registry.tsx`:

```tsx
import dynamic from "next/dynamic";
import { StatGroup, Stat } from "./stat-group";
import { PullQuote } from "./pull-quote";
import { Figure } from "./figure";
import { Timeline, TimelineEvent } from "./timeline";

// Charts are client-only (connect-web under the hood) — never SSR them.
const ShortInterestChart = dynamic(() => import("./short-interest-chart").then((m) => m.ShortInterestChart), { ssr: false });
const PriceChart = dynamic(() => import("./price-chart").then((m) => m.PriceChart), { ssr: false });

export const MDX_COMPONENTS = {
  ShortInterestChart, PriceChart, StatGroup, Stat, PullQuote, Figure, Timeline, TimelineEvent,
} as const;
```

- [ ] **Step 5: Manifest test**

`__tests__/manifest.test.ts` (jest, follows existing web test setup):

```ts
import { MDX_COMPONENT_SCHEMAS, MDX_COMPONENT_NAMES } from "../manifest";
import { MDX_COMPONENTS } from "../registry";

test("registry and manifest agree on the palette", () => {
  expect(Object.keys(MDX_COMPONENTS).sort()).toEqual([...MDX_COMPONENT_NAMES].sort());
});

test("schemas reject bad props", () => {
  expect(MDX_COMPONENT_SCHEMAS.ShortInterestChart.safeParse({ code: "bhp!" }).success).toBe(false);
  expect(MDX_COMPONENT_SCHEMAS.Stat.safeParse({ label: "Short interest", value: "12.4%" }).success).toBe(true);
});
```

Run: `cd web && npx jest src/@/components/news/mdx` → pass. `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/@/components/news/mdx/
git commit --no-verify -m "feat(news): MDX component registry + palette manifest (charts, stats, quotes, figures, timeline)"
```

### Task 6: MDX render path on the article page

**Files:**
- Create: `web/src/@/components/news/mdx-take-body.tsx`
- Modify: `web/src/app/news/[slug]/page.tsx` (branch on `take.bodyFormat`)

- [ ] **Step 1: Install renderer**

Run: `cd web && npm install next-mdx-remote`
Expected: added to package.json (RSC-compatible v5+).

- [ ] **Step 2: MDX body component**

`mdx-take-body.tsx` (server component):

```tsx
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { MDX_COMPONENTS } from "./mdx/registry";
import { CitationPill } from "./take-body"; // export the existing pill renderer from take-body.tsx

// Reuse take-body's [ref-N] pill treatment by mapping markdown text nodes —
// simplest reliable route: pre-process body text, replacing [ref-N] with
// the same <Cite> anchor element take-body produces (extract that helper
// from take-body.tsx into web/src/@/components/news/citations.tsx and
// import it from BOTH bodies so the two paths render identical pills).

export function MdxTakeBody({ body, citations }: { body: string; citations: Array<{ refId: string; url: string; source: string }> }) {
  return (
    <div className="prose prose-invert prose-headings:font-serif max-w-none">
      <MDXRemote
        source={body}
        components={MDX_COMPONENTS}
        options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
      />
    </div>
  );
}
```

During implementation, extract the `[ref-N]` → pill logic from `take-body.tsx` into `web/src/@/components/news/citations.tsx` and wire it as a remark plugin (or pre-render string replacement producing a `Cite` component registered in the MDX map) so citation pills are identical in both paths.

- [ ] **Step 3: Branch in the page**

In `web/src/app/news/[slug]/page.tsx` where `TakeBody` renders:

```tsx
{take.bodyFormat === "mdx" ? (
  <MdxTakeBody body={take.bodyMd} citations={citations} />
) : (
  <TakeBody ... /* unchanged legacy path */ />
)}
```

- [ ] **Step 4: Smoke test with a fixture**

Temporarily set one dev take to MDX via psql (`UPDATE editorial_takes SET body_format='mdx', body_md = body_md || E'\n\n<StatGroup><Stat label="Test" value="12%" /></StatGroup>' WHERE slug='<some-slug>'`), run `make dev`, load `/news/<slug>`, confirm the stat box renders and legacy takes are unaffected. Revert the row.

- [ ] **Step 5: Commit**

```bash
git add web/src/@/components/news/ web/src/app/news/ web/package.json web/package-lock.json
git commit --no-verify -m "feat(news): MDX render path for editorial takes (next-mdx-remote, whitelisted palette)"
```

### Task 7: MDX compile gate in the pipeline

**Files:**
- Create: `scripts/take-writer/src/mdxgate.ts`
- Test: `scripts/take-writer/src/mdxgate.test.ts`

- [ ] **Step 1: Write failing tests first**

`mdxgate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateMdx } from "./mdxgate.js";

const LEDGER_REFS = new Set(["ref-1", "ref-2"]);
const KNOWN_CODES = new Set(["BHP", "ZIP"]);

describe("validateMdx", () => {
  it("passes a valid article", async () => {
    const r = await validateMdx(
      `Para one [ref-1].\n\n<ShortInterestChart code="BHP" window="6m" />\n\n<StatGroup><Stat label="Short interest" value="12.4%" cite="ref-2" /></StatGroup>`,
      { ledgerRefs: LEDGER_REFS, knownCodes: KNOWN_CODES },
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects unknown components", async () => {
    const r = await validateMdx(`<script>alert(1)</script>\n\n<Marquee />`, { ledgerRefs: LEDGER_REFS, knownCodes: KNOWN_CODES });
    expect(r.ok).toBe(false);
  });

  it("rejects import/export statements", async () => {
    const r = await validateMdx(`import x from "evil";\n\nhello`, { ledgerRefs: LEDGER_REFS, knownCodes: KNOWN_CODES });
    expect(r.ok).toBe(false);
  });

  it("rejects a chart for an unknown stock code or bad window", async () => {
    const r = await validateMdx(`<ShortInterestChart code="XYZ9" window="6m" />`, { ledgerRefs: LEDGER_REFS, knownCodes: KNOWN_CODES });
    expect(r.ok).toBe(false);
    const r2 = await validateMdx(`<ShortInterestChart code="BHP" window="7w" />`, { ledgerRefs: LEDGER_REFS, knownCodes: KNOWN_CODES });
    expect(r2.ok).toBe(false);
  });

  it("rejects a cite not present in the ledger", async () => {
    const r = await validateMdx(`<StatGroup><Stat label="x" value="1" cite="ref-9" /></StatGroup>`, { ledgerRefs: LEDGER_REFS, knownCodes: KNOWN_CODES });
    expect(r.ok).toBe(false);
  });

  it("stripMdxComponents degrades to plain markdown", async () => {
    const { stripMdxComponents } = await import("./mdxgate.js");
    const out = stripMdxComponents(`before\n\n<ShortInterestChart code="BHP" />\n\n<PullQuote>keep this text</PullQuote>\n\nafter`);
    expect(out).not.toContain("<ShortInterestChart");
    expect(out).toContain("keep this text"); // text children survive as a blockquote
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/take-writer && npx vitest run src/mdxgate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the gate**

Run `npm install @mdx-js/mdx zod` in `scripts/take-writer`. `mdxgate.ts`:

```ts
// Compile gate for LLM-emitted MDX. The component whitelist + prop schemas
// are the security boundary: no imports/exports, no unknown JSX, props
// validated, charts verified against real stock codes, cites against the
// ledger. Mirrors web/src/@/components/news/mdx/manifest.ts — keep in sync.
import { compile } from "@mdx-js/mdx";
import { z } from "zod";

const WINDOWS = ["1m", "3m", "6m", "1y"] as const;
export const COMPONENT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ShortInterestChart: z.object({ code: z.string().regex(/^[A-Z0-9]{2,5}$/), window: z.enum(WINDOWS).optional() }),
  PriceChart: z.object({ code: z.string().regex(/^[A-Z0-9]{2,5}$/), window: z.enum(WINDOWS).optional() }),
  StatGroup: z.object({}),
  Stat: z.object({ label: z.string().min(1), value: z.string().min(1), context: z.string().optional(), cite: z.string().regex(/^ref-\d+$/).optional() }),
  PullQuote: z.object({}),
  Figure: z.object({ src: z.string().url(), caption: z.string().optional(), credit: z.string().optional(), placement: z.enum(["full", "left", "right", "inset"]).optional() }),
  Timeline: z.object({}),
  TimelineEvent: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().min(1), cite: z.string().regex(/^ref-\d+$/).optional() }),
};

export interface MdxGateOptions { ledgerRefs: Set<string>; knownCodes: Set<string>; }
export interface MdxGateResult { ok: boolean; errors: string[]; componentCount: number; }

const JSX_TAG = /<([A-Z][A-Za-z]*)\b([^>]*?)\/?>(?![^<]*<\/\1>)?/g;
const ATTR = /([a-zA-Z]+)\s*=\s*"([^"]*)"/g;

/** Extract {name, props} for every capitalised JSX element via regex —
 *  intentionally simple; compile() below is the real syntax check. */
export function extractComponents(body: string): Array<{ name: string; props: Record<string, string> }> {
  const out: Array<{ name: string; props: Record<string, string> }> = [];
  for (const m of body.matchAll(/<([A-Z][A-Za-z]*)\b([^>]*?)\/?>/g)) {
    const props: Record<string, string> = {};
    for (const a of m[2]!.matchAll(ATTR)) props[a[1]!] = a[2]!;
    out.push({ name: m[1]!, props });
  }
  return out;
}

export async function validateMdx(body: string, opts: MdxGateOptions): Promise<MdxGateResult> {
  const errors: string[] = [];
  if (/^\s*(import|export)\s/m.test(body)) errors.push("import/export statements are forbidden");
  if (/<script\b/i.test(body)) errors.push("script tags are forbidden");

  const comps = extractComponents(body);
  for (const c of comps) {
    const schema = COMPONENT_SCHEMAS[c.name];
    if (!schema) { errors.push(`unknown component <${c.name}>`); continue; }
    const parsed = schema.safeParse(c.props);
    if (!parsed.success) { errors.push(`<${c.name}> invalid props: ${parsed.error.issues.map((i) => i.message).join("; ")}`); continue; }
    if ((c.name === "ShortInterestChart" || c.name === "PriceChart") && !opts.knownCodes.has(c.props.code ?? "")) {
      errors.push(`<${c.name}> unknown stock code "${c.props.code}"`);
    }
    if (c.props.cite && !opts.ledgerRefs.has(c.props.cite)) {
      errors.push(`<${c.name}> cites ${c.props.cite} which is not in the ledger`);
    }
  }

  if (errors.length === 0) {
    try {
      await compile(body, { format: "mdx" }); // real syntax check
    } catch (err) {
      errors.push(`mdx compile failed: ${String((err as Error).message).slice(0, 200)}`);
    }
  }
  return { ok: errors.length === 0, errors, componentCount: comps.length };
}

/** Degrade MDX to plain markdown: PullQuote → blockquote, Stat → bold line,
 *  TimelineEvent → list item, everything else removed. */
export function stripMdxComponents(body: string): string {
  return body
    .replace(/<PullQuote>([\s\S]*?)<\/PullQuote>/g, (_m, t: string) => `> ${t.trim()}`)
    .replace(/<Stat\b[^>]*label="([^"]*)"[^>]*value="([^"]*)"[^>]*\/>/g, "**$1: $2**")
    .replace(/<TimelineEvent\b[^>]*date="([^"]*)"[^>]*label="([^"]*)"[^>]*\/>/g, "- $1 — $2")
    .replace(/<\/?[A-Z][A-Za-z]*\b[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/take-writer && npx vitest run src/mdxgate.test.ts`
Expected: all 6 PASS. Then full suite: `npm test` → no regressions.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/src/mdxgate.ts scripts/take-writer/src/mdxgate.test.ts scripts/take-writer/package.json scripts/take-writer/package-lock.json
git commit --no-verify -m "feat(take-writer): MDX compile gate (whitelist + zod props + data verification + markdown fallback)"
```

---

## Phase 3 — Writer & investigator data spine

### Task 8: `get_financials` drilldown

**Files:**
- Modify: `scripts/take-writer/src/drilldowns.ts` (new function after `reportLine`)
- Modify: `scripts/take-writer/src/tools.ts` (declaration + dispatch case)
- Test: `scripts/take-writer/src/drilldowns.test.ts`

- [ ] **Step 1: Failing test**

Append to `drilldowns.test.ts` (match the existing fake-Queryable pattern in that file):

```ts
it("getFinancials returns per-report metric sets with ledger sources", async () => {
  const pg = fakePg([
    { report_url: "https://x/a", report_type: "annual_results", report_title: "FY25 results", report_date: "2026-02-20", metrics: { revenue: "1.2B", net_profit: "80M" } },
    { report_url: "https://x/b", report_type: "half_year_results", report_title: "H1 FY25", report_date: "2025-08-20", metrics: { revenue: "600M" } },
  ]);
  const reports = await getFinancials(pg, "BHP", 3);
  expect(reports).toHaveLength(2);
  expect(reports[0]!.metrics.revenue).toBe("1.2B");
  expect(reports[0]!.source.type).toBe("report");
});
```

Run: `npx vitest run src/drilldowns.test.ts` → FAIL (`getFinancials` not exported).

- [ ] **Step 2: Implement**

In `drilldowns.ts` after `reportLine` (~line 96):

```ts
export interface FinancialReport {
  reportType: string | null;
  reportDate: string | null;
  title: string | null;
  metrics: Record<string, string>;
  source: LedgerSource;
}

/** Full key-metric sets for the last n filings in one call (vs report_line's
 *  one metric per call) so dossiers reliably carry the financial trajectory. */
export async function getFinancials(pg: Queryable, code: string, n = 4): Promise<FinancialReport[]> {
  const { rows } = await pg.query(
    `SELECT report_url, report_type, report_title,
            to_char(report_date,'YYYY-MM-DD') AS report_date, metrics
     FROM financial_report_extractions
     WHERE stock_code=$1
     ORDER BY report_date DESC NULLS LAST, extracted_at DESC
     LIMIT $2`,
    [code, n],
  );
  return (rows as Array<{ report_url: string; report_type: string | null; report_title: string | null; report_date: string | null; metrics: Record<string, unknown> | null }>)
    .map((r) => ({
      reportType: r.report_type,
      reportDate: r.report_date,
      title: r.report_title,
      metrics: Object.fromEntries(Object.entries(r.metrics ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])),
      source: { type: "report", url: r.report_url, source: r.report_type ?? "report", headline: r.report_title ?? "(financial report)", date: r.report_date ?? "" },
    }));
}
```

- [ ] **Step 3: Tool declaration + dispatch**

In `tools.ts` GEMINI_TOOL_DECLS add:

```ts
  {
    name: "get_financials",
    description: "Pull the company's last few financial reports with their FULL metric sets (revenue, profit, eps, dividend, guidance, cash flow) in one call. Returns one citable source per report. PREFER this over report_line when building the financial picture; use report_line only for a targeted follow-up.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { n: { type: SchemaType.NUMBER, description: "How many recent reports (default 4)" } },
    },
  },
```

And in `dispatchTool`:

```ts
      case "get_financials": {
        const code = subjectCode ?? String(input.code ?? "");
        const reports = await getFinancials(pg, code, Number(input.n ?? 4));
        return JSON.stringify(reports.map((r) => ({ reportType: r.reportType, date: r.reportDate, metrics: r.metrics, citation: cite(ledger, r.source) })));
      }
```

(import `getFinancials` in the existing import list from `./drilldowns.js`).

- [ ] **Step 4: Tests pass + commit**

Run: `npm test` → all pass.

```bash
git add scripts/take-writer/src/drilldowns.ts scripts/take-writer/src/tools.ts scripts/take-writer/src/drilldowns.test.ts
git commit --no-verify -m "feat(take-writer): get_financials drilldown — full metric sets per filing, one citable source each"
```

### Task 9: Investigator mandate + writer emits MDX with standfirst

**Files:**
- Modify: `scripts/take-writer/src/investigator.ts` (system instructions — add financial-report requirement)
- Modify: `scripts/take-writer/src/narrative.ts` (schemas + prompt + DossierTake + synthesiseFromDossier)
- Modify: `scripts/take-writer/src/newsroom.ts` (insert/update SQL + beat derivation + gate invocation)
- Test: `scripts/take-writer/src/dossierwriter.test.ts`

- [ ] **Step 1: Investigator instructions**

In `investigator.ts`, in the system prompt where the dossier requirements are listed (find the `emit_dossier` instruction block), append:

```
Before emit_dossier you MUST: (a) state the short-interest trajectory from get_overview, and (b) call get_financials and include at least one financial-report citation when any filings exist for the stock. A dossier with zero report citations for a covered company is incomplete.
```

- [ ] **Step 2: Writer schema + prompt**

In `narrative.ts`:

- Add to both `TAKE_DOSSIER_SCHEMA` and `DEEPDIVE_DOSSIER_SCHEMA` properties (+required):

```ts
    standfirst: { type: SchemaType.STRING, description: "One-sentence dek under the headline, max 30 words, concrete numbers preferred, no clickbait." },
```

- In `synthesiseFromDossier`'s `basePrompt` array, append a palette section:

```ts
    "",
    "=== INTERACTIVE COMPONENTS (MDX) ===",
    MDX_PALETTE_DOC,
    "REQUIRED: exactly one <ShortInterestChart> for the subject stock (place after the data discussion) and one <StatGroup> with 2-4 stats whose values come from CITABLE SOURCES or the SHORT-POSITION DATA. Components go in the section prose on their own blank-line-separated lines.",
    "VOICE: masthead register. Concrete numbers in the first three paragraphs. No hedging filler ('it remains to be seen', 'time will tell'). Use a <PullQuote> only when a sentence earns it.",
```

where `MDX_PALETTE_DOC` is copied into `narrative.ts` as a string constant matching `web/src/@/components/news/mdx/manifest.ts` (take-writer cannot import from web; the gate test in Task 7 plus the skill doc keep them in sync).

- Extend `DossierTake`:

```ts
  standfirst: string;
  bodyFormat: "markdown" | "mdx";
```

- In `synthesiseFromDossier`, after `compactCitations` (line ~690), run the gate:

```ts
  const gate = await validateMdx(body, {
    ledgerRefs: new Set(citations.map((c) => c.refId)),
    knownCodes: new Set([stockCode, ...(overview?.peers ?? []).map((p) => p.code)]),
  });
  let finalBody = body;
  let bodyFormat: "markdown" | "mdx" = "mdx";
  if (!gate.ok) {
    console.warn(`[dossierwriter] ${stockCode}: MDX gate failed (${gate.errors.join(" | ")}) — stripping to markdown`);
    finalBody = stripMdxComponents(body);
    bodyFormat = "markdown";
  }
```

Return `bodyMd: finalBody, bodyFormat, standfirst: String(parsed.standfirst ?? "")`.

- [ ] **Step 3: Beat byline derivation (deterministic, not LLM)**

In `newsroom.ts` add:

```ts
const BEATS: Array<[RegExp, string]> = [
  [/mining|materials|metals|gold|lithium|uranium/i, "Mining & Resources"],
  [/energy|oil|gas|utilities/i, "Energy"],
  [/bank|financial|insurance|capital/i, "Banks & Finance"],
  [/health|pharma|biotech|medical/i, "Health & Biotech"],
  [/tech|software|semiconductor|internet|media/i, "Technology & Media"],
  [/retail|consumer|food|beverage/i, "Consumer & Retail"],
  [/real estate|reit|property/i, "Property"],
];
export function deskByline(industry: string | null | undefined): string {
  const beat = BEATS.find(([re]) => re.test(industry ?? ""))?.[1] ?? "Markets";
  return `The Shorted Desk — ${beat}`;
}
```

- [ ] **Step 4: Persist new fields**

Both `INSERT INTO editorial_takes` statements (newsroom.ts:412 and :460) gain columns `body_format, standfirst, byline` with values from the take + `deskByline(industry)`, and the `ON CONFLICT` update sets them (`body_format=EXCLUDED.body_format, standfirst=EXCLUDED.standfirst, byline=EXCLUDED.byline`).

- [ ] **Step 5: Tests**

Extend `dossierwriter.test.ts` (it injects `DossierWriterDeps`) — make the fake `generate` return a body containing a valid `<ShortInterestChart code="BHP" window="6m" />` + `standfirst`, assert `bodyFormat === "mdx"` and `standfirst` round-trips; second case: fake returns `<BadComponent />`, assert `bodyFormat === "markdown"` and body contains no `<`-component. Also unit-test `deskByline("Gold Mining") === "The Shorted Desk — Mining & Resources"` in a new `newsroom.test.ts` (export `deskByline`).

Run: `cd scripts/take-writer && npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/take-writer/src/
git commit --no-verify -m "feat(take-writer): writer emits MDX + standfirst through compile gate; desk bylines; investigator must cite filings"
```

### Task 10: End-to-end pipeline verification (preview, no writes)

- [ ] **Step 1: Preview run**

```bash
cd scripts/take-writer
export GEMINI_API_KEY=$(grep GEMINI_API_KEY ../../.env | cut -d= -f2)
export DATABASE_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL --project=rosy-clover-477102-t5 --account=ben@shorted.com.au)
npx tsx src/run.ts newsroom-preview --stock=LOT
```

Expected: judge output shows a body containing `<ShortInterestChart`, a `<StatGroup>` with real numbers, a standfirst, ≥1 `[ref-N]` report citation, and `bodyFormat: mdx`. If the gate strips to markdown, read the gate errors and tune the palette prompt (this is the improvement loop the skill documents).

- [ ] **Step 2: Commit any prompt tuning**

```bash
git add scripts/take-writer/src/narrative.ts
git commit --no-verify -m "tune(take-writer): palette prompt adjustments from preview runs"
```

---

## Phase 4 — Masthead UI

### Task 11: Editorial typography + masthead front page

**Files:**
- Modify: `web/src/app/layout.tsx` or the font module it imports (add serif via `next/font/google`)
- Create: `web/src/@/components/news/masthead/lead-story.tsx`, `story-stack.tsx`, `wire-list.tsx`, `market-pulse.tsx`, `masthead-header.tsx`
- Modify: `web/src/app/news/page.tsx` (recompose with the new components)

- [ ] **Step 1: Serif display font**

Add `Newsreader` (Google) with `variable: "--font-serif"` in the root font setup, exposed in Tailwind config as `fontFamily: { serif: ["var(--font-serif)", "Georgia", "serif"] }`. Verify existing pages unaffected (`npx tsc --noEmit`, visual spot-check).

- [ ] **Step 2: Masthead components**

All server components, shadcn primitives, dark/amber theme. Structure (complete the JSX during implementation following these contracts):

- `masthead-header.tsx`: section identity — "Shorted **Newsroom**" wordmark line (serif), en-AU long date, thin amber rule.
- `market-pulse.tsx`: horizontal strip of top-5 short movers (reuse `getTopShorts` server action used by the dashboard — grep `getTopShorts` under `web/src/app/actions/`); each entry `CODE 12.4% ▲0.8`, monospace, links to `/shorts/[code]`.
- `lead-story.tsx`: props `{ take: EditorialTake }` — full-width topical hero (16:9, `hero_caption`/`hero_credit` under it in muted small caps), beat tag (from `byline` after the em-dash), serif headline up to `text-5xl`, standfirst (`text-xl text-muted-foreground font-serif`), byline + date line.
- `story-stack.tsx`: props `{ takes: EditorialTake[] }` — 2-4 secondary takes, horizontal rules between, headline (serif, `text-2xl`) + standfirst + beat tag, small thumbnail right.
- `wire-list.tsx`: props `{ groups: Record<string, NewsCardArticle[]> }` — "The Wire" heading, day-grouped compact rows (time, source, headline, sentiment dot, syndication chip from Task 3). Replaces the current card grid for aggregated news.

- [ ] **Step 3: Recompose the page**

`news/page.tsx` keeps its data fetching (`getMarketNews(60,false)`, `listEditorialTakes(12,0,"")`, `groupByDay`) and SEO metadata, recomposed:

```tsx
<DashboardLayout>
  <MastheadHeader />
  <MarketPulse />
  <LeadStory take={leadTake} />
  <div className="grid gap-10 lg:grid-cols-[2fr,1fr]">
    <StoryStack takes={secondaryTakes} />
    <WireList groups={groupByDay(articles)} />
  </div>
</DashboardLayout>
```

Lead = newest published take (fallback: current TakeHero behaviour if none). `secondaryTakes` = next 4, deduped by stock code as `TakeCardGrid` does today (reuse its dedupe helper).

- [ ] **Step 4: Verify**

`cd web && npx tsc --noEmit` → clean. `make dev`, open `localhost:3020/news`, check: lead story serif headline + standfirst, pulse strip numbers real, wire list deduped with chips, mobile single-column.

- [ ] **Step 5: Commit**

```bash
git add web/
git commit --no-verify -m "feat(news): masthead front page — lead story, story stack, wire list, market pulse, serif type"
```

### Task 12: Article page upgrade

**Files:**
- Modify: `web/src/app/news/[slug]/page.tsx`
- Modify: `web/src/@/components/news/take-body.tsx` (drop cap styling only; shared citations module from Task 6)
- Create: `web/src/@/components/news/article-header.tsx`, `sources-footer.tsx`, `related-coverage.tsx`

- [ ] **Step 1: Article header**

`article-header.tsx`: beat tag (amber, small caps) → serif headline (`text-4xl md:text-5xl`) → standfirst (serif, muted, `text-xl`) → byline · date · `{Math.max(1, Math.round(wordCount / 220))} min read` → hero `<Figure>` with `hero_caption` + `hero_credit`. Falls back gracefully when standfirst/byline empty (legacy takes).

- [ ] **Step 2: Body polish**

In both body paths: first paragraph drop cap via `first-letter:` utilities (`prose-p:first-of-type:first-letter:float-left first-letter:font-serif first-letter:text-6xl first-letter:pr-2 first-letter:leading-none` on the first block only — implement as a `DropCapParagraph` wrapper for the first text block to avoid styling every paragraph).

- [ ] **Step 3: Sources footer + related coverage**

`sources-footer.tsx`: numbered list of `citations` (favicon-less: source name, headline, date, external link icon), orange accent for `type==='report'` matching the pill colors. `related-coverage.tsx`: server component fetching `getStockNews(take.stockCode, 5)` and rendering compact wire rows ("More on {CODE}"). Wire both into `[slug]/page.tsx` below the body, above the existing related-takes block.

- [ ] **Step 4: Verify + commit**

`npx tsc --noEmit`; load a legacy take and (once Phase 3 ships one) an MDX take locally — both render, citations identical.

```bash
git add web/
git commit --no-verify -m "feat(news): article page — masthead header, drop cap, sources footer, related coverage"
```

---

## Phase 5 — Image uplift

### Task 13: Topical hero from the art-director; OG keeps brand art

**Files:**
- Modify: `scripts/take-writer/src/art-director.ts` (plan includes hero)
- Modify: `scripts/take-writer/src/newsroom.ts` (hero generation path + og decoupling + persist caption/credit)
- Modify: `scripts/take-writer/src/validator.ts` (stop ignoring the hero)

- [ ] **Step 1: Hero in the image plan**

In `art-director.ts` `PLAN_SCHEMA`, add `role: { type: SchemaType.STRING, enum: ["hero", "inline"] }` to plan items (required), and extend the system prompt: *"The FIRST image is the HERO: role='hero', ratio='landscape', documentary or environmental style, the single most arresting concrete subject from the dossier (real project, site, material, location). It must work as the page-top image of a serious financial masthead."* `designImagePlan` validates exactly one `role==='hero'` (fallback: promote the first landscape item).

- [ ] **Step 2: Wire the hero into newsroom.ts**

Where `--with-images` currently calls the brand-prompt hero generator (newsroom.ts:286-326): when an art-director plan exists, render the `role==='hero'` item at quality `high`, upload as `takes/{slug}-hero.png`, write `hero_image_url`, `hero_caption` (the plan item's caption), `hero_credit = 'AI-generated illustration'`. The remaining plan items become `layout_images` as today. The **brand-prompt path moves to og generation**: keep generating the abstract dark-amber image but store it ONLY in `og_image_url` (existing column, proto field 10). Update the two INSERT/UPDATE statements accordingly (`hero_caption`, `hero_credit` columns from Task 4).

- [ ] **Step 3: Validator judges the hero**

In `validator.ts`, remove the hero-exclusion (memory: "Judge IGNORES the abstract brand hero") — the judge prompt now includes the hero with the criterion *"does the hero read as a credible masthead lead image for this story?"*. Keep the per-image fix loop unchanged.

- [ ] **Step 4: Verify**

```bash
GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/gcloud/legacy_credentials/ben@shorted.com.au/adc.json \
npx tsx src/run.ts regen-images --slug=<existing-slug>
npx tsx src/run.ts validate-article --slug=<existing-slug>
```

Expected: new topical hero in GCS + hero_caption/credit set, validator score ≥8/10, og_image_url still the brand abstract.

- [ ] **Step 5: Commit**

```bash
git add scripts/take-writer/src/
git commit --no-verify -m "feat(take-writer): topical photojournalistic hero via art-director; brand art moves to OG only; validator judges hero"
```

### Task 14: Photographic craft in the style library

**Files:**
- Modify: `scripts/take-writer/src/art-director.ts` (STYLE_PROMPTS map or equivalent)

- [ ] **Step 1: Enrich style prompts**

For each style, add lens/light/composition vocabulary + negative constraints. Pattern (apply to all seven styles):

```ts
documentary: "Documentary news photograph. 35mm lens, natural available light, shallow depth of field, off-centre composition with leading lines, Reuters/Bloomberg wire-photo realism. NOT: text, charts, logos, readable signage, recognisable faces, watermark, illustration look, oversaturation.",
aerial: "Aerial photograph, golden-hour low sun, long shadows, 3/4 oblique angle (not straight down), atmospheric haze at the horizon. NOT: text, logos, map labels, drone in frame, fisheye distortion.",
```

…and equivalents for `still_life` (single warm key light, stone/steel surface, macro detail), `isometric` (clean 3D render, translucent materials, single amber accent), `archival` (grainy monochrome, period-correct), `abstract` (folded paper/gradient planes, brand amber on near-black), `environmental` (wide establishing shot, human-scale but faceless figures distant).

- [ ] **Step 2: Verify + commit**

`regen-images --slug=<slug>` once; eyeball output, run `validate-article`.

```bash
git add scripts/take-writer/src/art-director.ts
git commit --no-verify -m "feat(take-writer): photographic craft vocabulary + negative constraints per image style"
```

---

## Phase 6 — The skill

### Task 15: `.claude/skills/newsroom/SKILL.md`

**Files:**
- Create: `.claude/skills/newsroom/SKILL.md`

- [ ] **Step 1: Write the skill**

Frontmatter + sections (write the real content from what shipped, not placeholders — the implementing agent has just built all of it):

```markdown
---
name: newsroom
description: Operate and improve the Shorted investigative newsroom — generate, validate, publish, and iterate on MDX editorial takes. Use when running newsroom-daily/preview, regenerating images, fixing article quality, extending the MDX palette, or debugging duplicates in the wire feed.
---
```

Required sections, each populated from the implemented state:
1. **Architecture** — pipeline diagram (editor→investigator→writer(+MDX gate)→art-director→validator), file map in `scripts/take-writer/src/`.
2. **Grounding invariants (NEVER break)** — ledger-only `[ref-N]` cites; `compactCitations` drops everything else; MDX gate strips/holds; chart codes verified against real data; `shouldHoldAsDraft` semantics.
3. **Commands** — the four CLI commands with full env setup (GEMINI_API_KEY from `.env`; OPENAI_API_KEY/DATABASE_URL via `gcloud secrets … --project=rosy-clover-477102-t5 --account=ben@shorted.com.au`; `GOOGLE_APPLICATION_CREDENTIALS` legacy ADC for GCS writes).
4. **MDX palette** — current component table; the three-place sync rule (web manifest, mdxgate schemas, narrative palette doc) and how to add a component (registry → manifest → gate schema → palette doc → prompt → test).
5. **Quality rubric + improvement loop** — preview → judge output (standfirst? chart placed well? stats grounded? hero topical?) → tune prompts in narrative.ts/art-director.ts → `validate-article` → publish. Include the banned-phrase retry and validator score thresholds (hold below 7/10).
6. **Dedup runbook** — inline clustering behaviour, manual backfill command (`RUN_MODE=cluster-news CLUSTER_LOOKBACK_HOURS=…`), how to verify (`SELECT … FROM v_news_clusters`).
7. **Prod gotchas** — psql-only migrations, `gemini-3-pro-preview` 404, Vercel deploy from repo root, `--no-verify` commits, cron still unprovisioned.

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/newsroom/
git commit --no-verify -m "feat(skills): newsroom operating skill — commands, invariants, MDX palette, improvement loop"
```

### Task 16: Final verification sweep

- [ ] **Step 1: Full test pass**

```bash
cd services && go build ./... && go test ./shorts/... ./news-aggregator/...
cd ../scripts/take-writer && npm test
cd ../../web && npx tsc --noEmit && npx jest src/@/components/news
```

Expected: all green.

- [ ] **Step 2: One real article end-to-end**

`newsroom-daily` (no `--auto-publish`) with `--with-images` for one stock → inspect the draft row → publish via the existing admin path → `validate-article --slug=…` → load `/news/<slug>` and `/news` locally and screenshot both (Playwright MCP per project rules) for the PR.

- [ ] **Step 3: Update memory + PR**

Update `investigative-newsroom.md` memory (MDX palette, topical hero, dedup inline, skill location). Push branch, open PR against `main` summarising the five workstreams with the screenshots.

---

## Self-review notes

- **Spec coverage**: dedup (Tasks 1-3), MDX foundation (4-7), data spine (8-10), masthead UI (11-12), images (13-14), skill (15), testing (throughout + 16). Spec's "OG decoupling" → Task 13 Step 2; "validator includes hero" → Task 13 Step 3; "investigator prefers primaries" → Task 3 Step 4.
- **Known soft spots an implementer must resolve in place**: exact editorial-takes store filename (Task 4 Step 4 — grep given), the visx chart primitive to reuse (Task 5 Step 3 — grep given), citation-pill extraction into a shared module (Task 6). These are discovery steps with explicit search commands, not design gaps.
- **Type consistency**: `DossierTake.bodyFormat` (Task 9) matches `body_format` column (Task 4) and proto field 20; `hero_caption`/`hero_credit` flow Task 4 → 13 → 12; manifest names (Task 5) = gate schemas (Task 7) = palette doc (Task 9).
