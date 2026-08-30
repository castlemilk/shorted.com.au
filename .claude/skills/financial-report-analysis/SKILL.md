---
name: financial-report-analysis
description: Analyse an ASX company's financial results and publish a data-led piece to /news — find who just filed, pull verified short-position and announcement data, write, and publish. Use when a company reports, when asked for a report/profile/analysis on a ticker, or when working on the results-filing watch or the take-writer newsroom.
---

# Company Financial Report Analysis

End-to-end: from "who just reported" to a published, fact-checked piece on
`/news`. Covers the results-filing trigger (`scripts/take-writer`), the data
pulls that ground every claim, and the publish path.

## 1. The pipeline

```
asx_announcements (announcements job, daily, ~4.5k stocks x 2y)
  → results-watch          classify filings from HEADLINES, rank by short interest
  → newsroom / hand-write  research + draft
  → editorial_takes        DRAFT row (published_at NULL = the review gate)
  → publish                set published_at + revalidate /news
```

```bash
cd scripts/take-writer
DATABASE_URL=<prod> npx tsx src/index.ts results-watch --since-days=7 --limit=12
DATABASE_URL=<prod> npx tsx src/index.ts newsroom --stock=TLX
```

`/news` is **database-backed** (`editorial_takes`), unlike `/blog` which is
files in `web/_blogs`. Publishing therefore needs a DSN — see §5.

## 2. Finding who reported — do NOT use `announcement_type`

`asx_announcements.announcement_type` is wrong for this in **both** directions.
Measured on prod 2026-08-24:

| | Reality |
|---|---|
| `announcement_type='earnings'` | 89% is dividend/distribution **admin** (257 of 288 in 21 days) |
| Appendix 4D/4E (the statutory filing) | **4,106 sit in `'other'`**, only 25 in `'earnings'` |

`classifyResultsFiling()` in `src/results-watch.ts` classifies on the
**headline** and ignores `announcement_type`. Kinds: `appendix_4de` (statutory,
strongest), `annual_report`, `period_results`.

**The exclusions are the hard part, not the positives.** These all contain
results language and are NOT filings — triggering research on one produces an
article analysing results that do not exist yet:

- `"FY26 Results Date and Market Briefing"` — scheduling notice
- `"Notice of FY26 Results Market Briefing"` — any `^Notice of`
- `"AMX to present FY26 Results at ... Webinar"` — `to present`
- `"...FY26 Results Webinar"` — webinar with no release language
- `"...Results Presentation - Registration Details"` — logistics
- `"Results of Meeting"` / `"Results of 2025 Annual General Meeting"` — AGM votes
- `"Dividend/Distribution - AMA"` — the 89%

**But exclusions must not swallow real filings.** `"FY26 Financial Results
Release and Webinar"` and `"FY26 Financial Results and Dividend"` are both real.
`STRONG_FILING` markers (`appendix 4[de]`, `results release|announcement|
summary`) override any exclusion. This bug has now been made twice — once for
dividends, once for webinars.

**Validate against real headlines, not just unit tests.** Four false results
survived a passing unit suite and were only caught by running the classifier
over 632 real headlines and reading the accept/reject lists:

```bash
psql "$DSN" -t -A -F'|' -c "SELECT stock_code, headline FROM asx_announcements
  WHERE announcement_date >= CURRENT_DATE - 7
    AND (headline ~* 'appendix 4[de]|annual report|result|financial report')" > /tmp/heads.txt
# then classify each and eyeball BOTH lists
```

## 3. Data pulls — every claim must trace to one

Use the E2E bypass headers; a bare curl UA is challenged at the edge, and a
spoofed Googlebot UA from a non-Google IP is correctly rejected.

```bash
SEC=$TF_VAR_rate_limit_testing_bypass_secret   # repo-root .env
H=(-H "User-Agent: Shorted-E2E/1.0" -H "X-Shorted-Testing-Bypass: $SEC")

curl -s "${H[@]}" "https://api.shorted.com.au/edge/v1/stock/DRO"                  # current %, shares, industry
curl -s "${H[@]}" "https://api.shorted.com.au/edge/v1/stock/DRO/data?period=1Y"   # DAILY series
curl -s "${H[@]}" "https://api.shorted.com.au/edge/v1/top-shorts?period=1M&limit=15"
```

### ⚠️ `period=MAX` IS DOWNSAMPLED — never take a figure from it

MAX returns ~255 points spanning 8+ years. It **smooths away daily extremes and
misreports both the value and the date.** A published article was wrong because
of this:

| | From MAX (wrong) | Daily 1Y series (right) |
|---|---|---|
| DRO peak | 15.52% on 10 Aug | **16.03% on 31 Jul** |
| DRO 10 Aug | 15.52% | 15.65% |
| Jul month-end | 14.98% | 16.03% |

Every monthly figure was off, and the narrative inverted: the position was not
plateauing at a high, it had been falling every week since the peak.

**Use `1Y` or shorter for any point value, peak, or month-end.** MAX is for
shape only.

Housing/economy figures come from Connect POST, not `/edge/v1`:
`HousingService/GetHousingOverview`, `EconomyService/GetEconomicSeries`
(field is **`seriesKeys`**, plural array; response is `series[].{info,observations}`).

## 4. Writing

Match the house style in `content/news/*.mdx` and `web/_blogs/*.mdx`: lead with
the number, tables over prose, internal links to `/shorts/<CODE>`, and an
explicit section on what the data does **not** show.

**Rules that are not negotiable:**

- **Position data has no thesis in it.** ASIC's aggregate cannot distinguish a
  bear from a convertible-note holder hedging. Say so.
- **Never attribute causation you cannot isolate.** A housing piece asked for
  "after the reforms" attributes nothing to policy, because isolating a reform
  from rates, migration and construction costs is not possible with this data.
- **Audit your own arithmetic before publishing.** A pre-publish pass caught: a
  date error (10→17 Aug is seven days, not ten), "fourfold"/"sevenfold" where
  the data said 4.8x/6.8x, a "flat" reading that was a round trip through a new
  high, and four unverified historical assertions.
- Verify every ticker resolves and every internal link exists.

**Component restriction.** The `/news` MDX renderer maps standard
markdown/HTML plus `CitationPill`/`CitationSources` — **nothing else, and an
unknown component renders as NOTHING, silently.** `<Info>` and
`<RegisterEmail>` are blog-only. `import-mdx` refuses a file that would ship
with a hole in it.

## 5. Publishing

```bash
task news:publish:check                     # dry run, writes nothing
CONFIRM=prod task news:publish              # whole content/news dir
CONFIRM=prod task news:publish FILE=path    # one file
```

Idempotent: content updates in place, already-published rows are skipped — so
this is also how you ship a **correction**.

Frontmatter: `slug`, `headline` (required); `standfirst`, `byline`,
`stockCode`, `tier` (`take|deep_dive`), `bodyFormat` (`markdown|mdx`),
`ogImageUrl`. `stockCode` is optional — a market-wide piece has none.

**Where the credentials actually are** (none of this is in GCP Secret Manager):

| What | Where |
|---|---|
| `DATABASE_URL` (prod Supabase pooler) | `services/.env` |
| `OPENAI_API_KEY`, `GEMINI_API_KEY` | `services/.env` |
| `REVALIDATION_SECRET` | `~/.shorted-housing-crawl.env` |
| GCS write (images) | `GOOGLE_APPLICATION_CREDENTIALS=services/shorted-dev-aba5688f-*.json` |

ADC is the **personal** gmail account and gcloud's active account may be a
**greenveil** SA — neither can write to `shorted-company-logos`.

## 6. Images

```bash
DATABASE_URL=… OPENAI_API_KEY=… GEMINI_API_KEY=… GOOGLE_APPLICATION_CREDENTIALS=… \
  npx tsx src/index.ts regen-images --slug=<slug>
```

~$0.32/article. Safe to retry — a failed run can no longer delete an existing
image set (it used to, and wiped three published images off a live article; the
GCS objects outlived the DB reference, which is the only reason they were
recoverable).

The hero renders at `high` and falls back to `medium`: `high` at 1536×1024
fails consistently against this API, dropping the connection at ~180s and
surfacing as `"Connection error"`, which reads like a network blip. It is not a
client timeout — the default is already 600s.

## 7. Landmines

- **Never patch regex-heavy TS with a python heredoc.** `\b` becomes a literal
  BACKSPACE byte; the patterns look correct in review and can never match.
  Use Edit.
- The `/blog` and `/news` surfaces are different systems. Do not "move" a post
  between them by moving a file.
- `vercel env pull` returns the literal `"[SENSITIVE]"` for sensitive vars —
  check LENGTH before trusting a secret in a test.
- The pre-push hook aborts git ops; `--no-verify` is the norm here.

## 8. Related

`$newsroom` (take-writer generally), `$weekly-reports` (the aggregate
weekly/monthly reports, a different pipeline), `$economy-data`. Editorial
standards: `docs/influence-editorial-standards.md`.
