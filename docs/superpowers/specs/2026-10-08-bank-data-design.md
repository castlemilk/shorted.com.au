# Bank data: APRA statistics, bank measures from filings, and a Go extractor

Date: 8 October 2026. Status: design for review.

## Why

A results video, the stock page and the MCP server cannot tell a bank's story. A bank is
read through its margin, its capital, its costs, its bad debts and the size of its loan and
deposit books. Shorted serves none of those.

What Shorted already serves for CBA (`GetStockFundamentals`, FY to 30 June 2026):
- net interest income A$25.6bn, interest expense, total assets A$1.45tn, equity A$78.7bn;
- ROE 13.8%, ROA 0.77%, payout 76%.

What it lacks:
- net interest margin (NIM), CET1 capital ratio, cost-to-income;
- loan impairment expense, gross loans and customer deposits;
- cash NPAT, the profit figure banks lead with.

Every bank states these on the first pages of its results announcement. APRA publishes
the loan books, deposit books and capital ratios per bank.

The owner asked for four things:
1. Extend filing extraction to bank measures.
2. Use current cheap models and current extraction tooling ("deepseek or other cheaper models").
3. Move extraction to Go ("ideally it's all in golang").
4. Serve the bank data through the API and MCP, and ingest APRA's statistics.

## What exists (8 Oct, `origin/main` 81a9a079a)

- **Extractor.** `services/report-extractor` (Python) uses a direct path, live since 29 Sep:
  - one OpenRouter call per document;
  - DeepSeek V4 Flash as primary, Gemini 2.5 Flash-Lite as checker, Gemini 2.5 Flash as
    arbiter;
  - deterministic checks: the quote is located in the document text, the value is inside
    the quote, the unit is scaled.

  Measured on 70 hand-verified revenue, NPAT and EPS figures it found 95.7%, against
  56–59% for the old langextract path, at about $0.16 for a 120-document night.
- **Model access.** Google now restricts Gemini 2.5 to existing users. The checker and
  arbiter ids are therefore at risk.
- **Go port.** A Go port, `services/jobs/internal/jobs/reportextract`, is not deployed. It
  copies the old langextract design. Its PDF library (`ledongthuc/pdf`) recovers 77% of
  the numbers the other engines agree on, and it splits "cost-to-income" across lines.
- **Readers.** Readers of `financial_report_extractions.metrics` apply different checks.
  The highlights RPC, the weekly-report prompt and the newsroom's TypeScript read new
  classes there with no document gate.
- **MCP budget.** `tools/list` is 89.5 KB against a 90 KB budget. `get_stock_fundamentals`
  has about 1 KB of per-call headroom.
- **APRA.** It publishes per-bank data as CC BY XLSX files. There is no API.
  - **MADIS** (monthly) holds domestic loan and deposit books, keyed by ABN.
  - **ADICP** (quarterly) holds CET1, Tier 1, total capital, RWA, LCR, NSFR and MLH per
    ADI, keyed by ABN, from 2013.
  - Neither has NIM, cost-to-income, impairments or profit per bank. Those come only from
    each bank's filings.
- **ADIs.** Fourteen ADIs map to ten listed codes: CBA, WBC, NAB, ANZ (plus Norfina,
  formerly Suncorp Bank), MQG, BOQ, BEN, MYS, AMP, JDO, TYR, BBC and HGH.

## Goals and success criteria

- **APRA.** For every mapped code, `GetBankMetrics` returns APRA's latest month (MADIS)
  and latest quarter (ADICP) within one day of APRA's release. Each value carries its
  provenance and APRA's credit line.
- **Filings.** For the bank gold set (below), the extractor publishes:
  - NIM, CET1, cost-to-income, loan impairment expense and cash NPAT for the latest
    result;
  - gross loans and customer deposits where the document states them.

  It publishes zero wrong values and finds at least 90% of the gold figures after
  verification.
- **Go extraction.** Extraction runs in Go and, before cutover, matches or beats the
  Python direct path on the general gold set. The Python financial-report extractor is
  then retired.
- **Cost.** Under $0.01 a document, with a measured cost per verified figure.
- **MCP.** The server serves the bank block and stays within its `tools/list` budget.
- **Video.** The dossier's bank chapter uses these measures instead of the interim lines
  it uses today.

## Decomposition

There are five phases, each with its own plan and pull request. A and B are independent
and can run side by side.

| Phase | Delivers | Depends on |
| --- | --- | --- |
| A | APRA ingest job, tables, ABN-to-ASX map | nothing |
| B | Go extraction core; bank-measures job; gold set and model bake-off | nothing |
| C | `GetBankMetrics` RPC, MCP `get_bank_metrics`, studio dossier follow-up | A, B |
| D | General results extraction on the Go core: shadow run, cutover, Python retired | B |
| E | Director-trade extraction on the Go core, with its data-quality fixes | D |

Out of scope:
- **The register-of-interests extractor.** It is operator-run, uses macOS Vision OCR and
  holds no financial figures.
- **Per-insurer statistics.** APRA paused general and life per-insurer data in June 2023,
  so IAG, SUN and QBE have none.
- **A stock-page bank card.** It is a small follow-on once C ships.
- **APRA's sector aggregates (QADIP, QPEX).** They are optional context for later.

## Phase A: APRA ingest

**Job.** `shorted apra -mode madis|adicp|register|all`, in the jobs monolith.

**Runs.** It runs once a day. Each run reads the publication page, resolves the workbook
link (never hard-coded), and downloads the workbook only when the page's published date
or the file's hash has changed. It defaults to dry-run (`APRA_DRY_RUN`), as the repo's
fetch jobs do. Only the scheduled job writes.

**Fetching.**
- An honest user agent: `shorted-apra/1.0 (+https://shorted.com.au)`.
- One file per dataset per run.
- `robots.txt` allows `/system/files/` and the publication pages.

**Parsing.** With `excelize`, which the repo already uses:
- MADIS back-series: one file, every month since March 2019, keyed by ABN.
- ADICP `Table 4`: the flat back series.
- The ADI register and the Financial Claims Scheme list (HTML), diffed for new,
  renamed and revoked ADIs.

**Storage** (migration 000133, replay-safe and in the deploy allowlist):

| Table | Holds |
| --- | --- |
| `apra_releases` | dataset, edition period, release date, source URL, sha256, row count, licence |
| `apra_adi`, `apra_adi_names` | each ABN and its name history |
| `apra_adi_asx` | ABN to ASX code, with `valid_from`/`valid_to` and a note, seeded with the 14 current links and the history (ME Bank into BOQ, Auswide into MYS, Norfina into ANZ) |
| `apra_madis` | one row per ABN and month, 27 nullable A$m columns, the release id |
| `apra_adicp` | one row per ABN and quarter: APRA's period, the entity's own quarter end (BOQ's runs a month early), capital amounts, RWA parts, ratios as published and as recomputed, LCR, NSFR, MLH, liquidity regime |
| `apra_breaks` | dated series breaks: the 2019 reporting change, acquisitions, the RACQ book moving to BEN in November 2026 |

A view per ASX code and period sums member ABNs that are valid at that period. It
derives the system share, year-on-year and three-month annualised growth, and flags any
period that crosses a break.

**Fail-closed validation.** A run that fails any of these writes nothing:
- the loan and deposit identities sum;
- RWA components add to the total;
- periods are contiguous;
- row counts are sane;
- CET1 is between 5% and 40%.

Two further checks make no change to the load:
- An unknown ABN raises an alert but does not block the run.
- A month-on-month move over 15% for a listed bank is flagged for review, not published
  as growth.

**Licence.** APRA's files are CC BY 3.0 AU (CC BY 4.0 on the site). Each release row
stores the credit line, and the API returns it:

> Source: Australian Prudential Regulation Authority (APRA), <publication>, <edition>,
> released <date>. © APRA, CC BY 3.0 AU. Shorted calculated shares, growth and group
> totals. APRA does not endorse this work.

**What the data can and cannot say.**
- MADIS is the domestic book of the licensed entity, not the group. Macquarie Bank is not
  Macquarie Group.
- The owner-occupied versus investor split is not comparable across the 2019 change.
- APRA gives no per-bank NIM, ROE, cost-to-income or leverage ratio.

## Phase B: the Go extraction core and bank measures

**Package `services/pkg/filingextract`.** It is shared by every extraction job:

| Part | What it does |
| --- | --- |
| fetch | Keeps today's ASX behaviour: `displayAnnouncement.do` resolution, `%PDF-` check, browser-shaped headers and cookies. Adds a 64 MiB cap. |
| text | `go-pdfium` (PDFium compiled to WebAssembly, no cgo, MIT and Apache licences). It matched PyMuPDF on every number across ten real filings, so the distroless image stays. One shared instance. Per-page text plus positioned text runs for a column-aware pass. |
| pages | Scores the first 40 pages by measure labels and numbers, then sends the best eight. The first eight pages are not enough: CBA's NIM, CET1 and cost-to-income sit on page 9 of its 152-page Profit Announcement. When a bank files both, the short ASX announcement is preferred. |
| models | A small OpenAI-compatible HTTP client for OpenRouter and DeepSeek, plus `google.golang.org/genai` for Gemini direct. The repo's Gemini SDK is end of life and cannot turn thinking off. API keys are always explicit, so a provider never receives another provider's key, and no key appears in a log. Thinking is off or minimal, JSON output, temperature 0, a per-call timeout. Usage and billed cost are recorded. |
| verify | A port of the Python direct path's checks: locate the quote (exact, whitespace-fuzzy, or label within 300 characters of the number), require the value's digits inside the quote, widen a bare table figure to its unit heading, per-measure required and forbidden label words, the shared few-shot denylist, sign from the quote. |
| consensus | A primary and a checker. On disagreement an arbiter decides; without a majority the value is withheld. A checker-only figure is never stored. |
| run | Budgets on documents, workers and minutes. Five consecutive model errors stop new work. Systemic errors exit 1. A model failure never writes a row. `cost_event` logs. |

**Bank vocabulary.** Each measure carries its period (FY, 1H or 2H, plus the end date),
its basis (statutory or cash) and a qualifier (for CET1, APRA Level 2 or International):

| measure | unit | note |
| --- | --- | --- |
| `net_interest_margin` | per cent | |
| `cet1_ratio` | per cent | the qualifier is required |
| `cost_to_income` | per cent | |
| `loan_impairment_expense` | A$m | a write-back is negative |
| `cash_npat` | A$m | its own field, never `net_income` |
| `gross_loans`, `customer_deposits` | A$m | only where the document states them |

**Storage.** Migration 000134 adds a `filing_measures` table:
- one row per document, measure, basis and qualifier;
- value and unit;
- period type and end;
- quote, character offsets and page;
- alignment, consensus, models and extractor version.

Bank measures never go into `financial_report_extractions.metrics`, because ungated
readers read that column. One Go store method reads `filing_measures` through the trust
rules.

**Job.** `shorted bank-measures -mode extract|backfill|bench`:
- **extract** runs daily after the announcements crawler and takes the newest unprocessed
  results document for each mapped code.
- **backfill** takes each bank's last four results, about 56 documents.
- **bench** scores the gold set and writes nothing to the database.

It defaults to dry-run. It uses the existing `OPENROUTER_API_KEY` secret.

**Gold set and bake-off.**
- **Gold set:** 16 bank documents (two each for CBA, WBC, NAB, ANZ, MQG, BOQ, BEN and one
  of JDO or MYS). Each is read by a strong model and checked by eye. Each figure records
  its basis, period and qualifier.
- **Arms:** each takes go-pdfium text plus a model:
  1. DeepSeek V4.1 Flash, with zero-data-retention hosts pinned on OpenRouter;
  2. `openai/gpt-6-luna` (strict schema);
  3. Gemini 3.5 Flash-Lite, reading the 8-page PDF slice natively;
  4. Qwen 3.8 Flash, as a cost floor;
  5. `pdftotext -layout` instead of go-pdfium, as a layout reference.
- **Scoring:** after the verifier. Report hits, wrong values, misses, the withheld rate and
  cost per verified figure.
- **Choice:** primary, checker and arbiter are chosen on accuracy, because every arm
  costs under $0.006 a document.
- **Gate:** zero wrong published values and at least 90% found.

## Phase C: serving

**RPC.** `GetBankMetrics(stock_code)` goes on `StockService` and on the legacy service,
both public. It returns:
- the mapped ABNs and their validity;
- `latest`, a list of measures. Each has a value with a `has_value` flag, unit, period,
  basis, qualifier, source (`filing`, `apra_madis` or `apra_adicp`), source title and
  URL, and as-of date.
- `series`:
  - MADIS for 24 months: housing, business, total loans, deposits and system share;
  - ADICP for 12 quarters: CET1, LCR, NSFR;
  - filing NIM and cost-to-income for six halves.
- the APRA credit line.

An unmapped code returns an empty block, not an error.

**Precedence.**
- CET1 shows APRA's quarter where its date matches, and otherwise the filing's.
- NIM, cost-to-income, impairment and cash NPAT come only from filings.
- Loans and deposits show both the group figure (filing) and the domestic book (APRA),
  each labelled.
- Nothing is ever merged into one number.

**Caching.** Five minutes in process. The web tier uses a `bank-metrics` tag, which both
jobs ping after a load.

**MCP.** A new public tool, `get_bank_metrics` (scope `shorts:read`), with a lean output
schema. Its cost to `tools/list` is measured. Descriptions elsewhere are trimmed to fit;
if that cannot free enough, the budget is raised by the measured amount, with the
measurement in the commit.

**Codegen.** The proto change ships as one commit with every generated output: Go, web,
Java SDK, OpenAPI and the API docs.

**Studio.** A follow-up task in the video plan adds `GetBankMetrics` to the dossier. A
bank's balance-sheet chapter then shows NIM, CET1, cost-to-income, impairment, and loan
and deposit growth and share.

## Phase D: general results extraction in Go

1. Port the direct path's general vocabulary onto the core:
   - revenue, net profit, EPS, dividend, EBITDA and cash flow;
   - the underlying and diluted variants;
   - `document_meta` and the digest.

   It writes `financial_report_extractions` in the exact stored shape its readers expect.
2. Shadow run. For 14 days Go writes `financial_report_extractions_shadow` (same columns)
   beside Python's run, and a nightly comparison reports per-document agreement. Cutover
   needs:
   - at least 98% agreement on verified figures;
   - every Go-only figure spot-checked, with none wrong.
3. Cut over: Go writes the real table. Then retire the Python job, its image and the old
   langextract Go code.
4. Before the port lands, replace the restricted Gemini 2.5 checker and arbiter ids in the
   Python job's environment with the bake-off's choices. This is a config change.

A pre-flight read of `max(extracted_at)` confirms whether the August key outage left a
gap that needs a backfill.

## Phase E: director trades in Go

Port the director-trade extractor onto the core. Fix the causes behind the data-quality
findings in the video notes:
- the announcements crawler re-inserts an "Unknown Director" seed row once the extractor
  has rewritten the unique key;
- updates are keyed by URL, not by row;
- "2.1 million" is truncated to 2 shares;
- small share counts have no plausibility check.

Then backfill the roughly 24,000 affected rows. This phase gets its own plan when D is
done.

## Rules that hold in every phase

- **Unknown is withheld, never 0 and never guessed.**
- **Sources stay separate and labelled.** Every value carries its source, period and
  as-of date. A filing never overwrites an APRA value, and APRA never overwrites a filing
  value; both are shown.
- **Failed reads write nothing.** A failed model call or a failed parse writes nothing,
  and the next run retries.
- **No automatic retries or paid surprises.** Jobs have no automatic retries, carry
  budgets, and log cost.
- **Production writes are gated.**
  - New jobs default to dry-run; only the scheduled job writes.
  - Migrations land and are allowlisted before the code that reads them.
  - Nothing is merged or pushed without the owner's go-ahead.
- **Documents stay out of git.** PDFs and APRA workbooks are not committed. Tests use
  small transcribed excerpts and synthetic workbooks, and `bench` downloads what it
  scores.

## Jobs and deployment

- **Image.** Both new jobs (`shorted apra`, `shorted bank-measures`) are modes of the jobs
  monolith in the existing distroless `shorted-jobs` image. go-pdfium is WebAssembly, so the
  image does not change.
- **Two definitions per job.** Each job gets a Cloud Run job definition (manual and admin
  runs) and a VKE CronJob entry, following the cutover rule: `enabled:` in the jobs chart and
  `local.jobs_on_vke` in Terraform change together. Telesis monitors it through
  `cronjob-reporter`.
- **Job monitor.** Each job has a `jobmonitor/catalog.go` entry, so the admin console lists
  it.
- **Migrations.** 000133 (APRA) and 000134 (`filing_measures`) are replay-safe and
  allowlisted. Each lands before the code that reads it.
- **Secrets.** The extraction job reads `OPENROUTER_API_KEY`, which already exists in Secret
  Manager. The APRA job needs no secret.

## Testing

- **APRA:** synthetic workbooks built in tests (identities, breaks, an unknown ABN, BOQ's
  shifted quarter), and a parse of the real file's shape in `bench`.
- **Core:**
  - the verifier's cases ported from the Python tests;
  - consensus outcomes;
  - page scoring on transcribed CBA, NAB and WBC pages;
  - a go-pdfium digit-integrity test on a generated PDF.
- **Serving:** store tests against the integration database, proto parity, the MCP budget
  test, and that an unmapped code returns an empty block.
- **Phase D:** the shadow comparison report is the acceptance evidence.

## Costs

- APRA is free.
- Extraction costs $0.001–0.006 a document.
- The bank backfill (about 56 documents) is under $1.
- The bake-off, including the gold readings, is under $5.
- Running costs are under $2 a month.

## Questions for the owner

1. **Bake-off key.** It needs an OpenRouter key. The production secret `OPENROUTER_API_KEY`
   exists. Should I read it from Secret Manager into a local variable (never printed), or
   will you create a separate development key?
2. **DeepSeek hosting.** DeepSeek's first-party API stores prompts in China. The
   documents are public, but I recommend DeepSeek only through OpenRouter's
   zero-data-retention hosts. Agreed?
3. **Scope.** Phases D and E retire the Python financial and director extractors. The
   register-of-interests extractor stays in Python, since it runs on macOS OCR. Agreed?
