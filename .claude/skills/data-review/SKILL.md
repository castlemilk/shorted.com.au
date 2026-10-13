---
name: data-review
description: Find the documents Shorted could not turn into data (results documents never read, empty or unreadable extractions, rows the API withholds, dividend notices that failed), investigate a sample, fix the pipeline that dropped them, and record what was found. Use when asked to review data quality or problem reports, after changing the financial-report extractor or the dividend notice parser, after a reporting season, or when a stock page or video dossier is missing results or dividends.
---

# Data review: find what failed, fix why

The financial-report extractor and the dividend notice parser each turn ASX
PDFs into rows. Neither fails loudly when one document goes wrong; it just
leaves the row empty, writes nothing, or records an outcome nobody reads. This
skill is the loop that finds those documents and turns them into fixes:

1. **Review**: list the problem documents (`task data:review`).
2. **Investigate**: read a sample of documents as the pipeline read them, and
   decide WHY each failed.
3. **Fix**: change the pipeline with a test built from the real document.
4. **Verify**: after the deploy and the next scheduled run, review again.
5. **Record**: add a dated entry to `docs/data-review/LOG.md`.

Everything in steps 1 and 2 is read-only. A prod write (deleting a row so a
document is read again, executing a job by hand, applying a migration) needs
the user's explicit OK first. Never print a DSN, a key or a bypass secret.

## 1. Review

From the MAIN checkout (the task reads the prod DSN from `services/.env`,
which worktrees do not have):

```bash
task data:review                          # last 90 days, 25 rows a list
task data:review -- -days 30 -limit 60    # narrower window, longer lists
```

`shorted review` (`services/jobs/internal/jobs/review`) runs one READ ONLY
transaction on the session pooler and prints markdown. Save it to the
scratchpad if you will refer back to it. Every heading carries the complete
count, so compare counts between reviews, not row lists.

## 2. Triage each list

### Newest results document not read

A company's newest statutory results document, filed more than 7 days ago,
with no metrics and no digest. States: `never read`, `unreadable (no text
layer)`, or an empty-extraction state (below). Largest companies first.

- `never read` for a large company is a **selection** problem. The extractor
  reads one document per company per run (`--limit 360`): tier 0 is filed
  within 45 days, tier 1 is a company with no parsed filing or whose newest
  document is unread, tier 2 back-fills older documents. Preview where a
  company ranks before changing anything (read-only, selection only):

  ```bash
  cd services/report-extractor
  # A venv with the requirements: uv venv -p 3.11 <dir> && uv pip install --python <dir>/bin/python -r requirements.txt
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' ../../services/.env | cut -d= -f2-)" <venv>/bin/python - <<'EOF'
  import extract, extract_reports_concurrent as r
  rows = extract.select_extraction_targets(r.open_selection_connection(), recent=2, limit=0)
  print(len(rows), "companies pending")
  for i, x in enumerate(rows):
      if x["stock_code"] in {"CBA", "DRO"}:
          print(i, x["stock_code"], x["date"], x.get("empty_retry", False), x["title"][:60])
  EOF
  ```

  Run it from the main checkout's `services/report-extractor`, or point the
  `grep` at the main checkout's `services/.env`. Rank above the limit means it
  is read on the next run. Rank far below means the tier rule is wrong for it;
  fix `order_extraction_targets` with a case in `test_selection.py`.
- A document ASX lists under several codes is read once, under its owner
  (prices within 7 days of the newest, then ASIC's short report within 30,
  then market cap, then the code), and counts as read for every code that
  lists it: the review looks extractions up by URL.
- A company missing entirely may have no `financial_reports` entry for the
  document (`company-metadata.financial_reports`, filled by
  `shorted reports coverage` / `sync`), or a title the results classifier
  rejects (`extraction_trust.is_results_document` in Python,
  `extractiontrust.IsResultsDocument` in Go; they must agree).

### Empty extractions

No metrics and no usable digest (none, or one with no confidence or under 0.6,
the latest-filing summary's gate: with no metrics nothing else reads the row)
from a document that has text. The extractor reads each one
again, at most twice and at least 7 days apart, at up to 24 pages
(`EMPTY_RETRY_*` and `USABLE_DIGEST_MIN_CONFIDENCE` in `extract.py`). States: `retry due`, `next retry from
<date>`, `gave up after N attempts`, and `not read again: the title is not a
results document` (a notice read before the classifier rejected its title:
nothing to do).

- `retry due` / `next retry`: nothing to do yet; check the next review.
- `gave up`: investigate. Read the document as the extractor reads it:

  ```bash
  cd services/report-extractor && <venv>/bin/python - '<url>' <<'EOF'
  import sys, requests, extract
  s = requests.Session(); s.headers.update(extract.ASX_HEADERS)
  for pages in (8, 24, 60):
      text, status = extract.fetch_pdf_text(s, sys.argv[1], max_pages=pages)
      print(pages, status, len(text or ""))
  print((text or "")[:3000])
  EOF
  ```

  Then decide: the figures are past page 24 (a long annual report whose
  results table sits in the back half), the model's answer did not parse (look
  for `Digest JSON parse failed` in that run's log:
  `task job:prod:logs ENV=prod JOB=financial-report-extractor`), or the document holds
  no figures at all (a cover letter filed under a results title, which is a
  classifier fix). A prompt or validation change is benchmarked first with
  `bench_direct.py` / `bench_gold.py`, never tuned on one document.

### Unreadable documents

No text layer (a scanned PDF): `raw_text_length` under 100, never retried.
Usually the source's fault and nothing to fix. When a company re-lodges the
document with text, delete its marker row (with the user's OK) so the next run
reads it. If many come from one company or one month, the PDF engine may be
the problem; compare pymupdf with another reader before deciding.

### Rows the API withholds or trims

Rows that exist, but that the API serves only in part or not at all. The reason
says which gate:

- `metrics: N of M entries dropped by the trust funnel`: the extraction quoted
  text that is not in the document, or echoed the prompt's few-shot example
  (`few-shot echo`). Echo rows are repaired by one
  `--repair-echo-digests` run (the Report Extractor Repair workflow, dry run
  by default). Ungrounded entries point at the model or the prompt: benchmark.
- `digest confidence ... under 0.6`: the API's `latest_filing` gate. Read the
  digest next to the document. Low confidence on a clear results document is
  a prompt problem; on a thin one it is the gate working.
- `document names "X", not <company>`: the stated entity (already reduced by
  `cleanEntity`, so a registration number, an address or a bare "Limited" is
  never shown here) is not the company's name. The API applies `cleanEntity`
  to every stored row, but where in the document the entity is read from is
  decided once, at extraction (VIT's own 4E was stored as "Cortexa Pty Ltd",
  read from its control gained or lost section): after a rule about that
  changes, one `--repair-document-meta` run (the Report Extractor Repair
  workflow, `repair: document-meta`, dry run by default, never while the
  extractor runs) reads every row's entity again from its stored text, and
  its period (the next bullet). Its first run also applies #707's and #710's
  name rules to the rows stored before them. Every `renamed`, `added` and
  `kept` line of its dry run carries the company and the entity check's
  outcome (`now passes`, `now fails` or `no change`, counted in the summary
  line), and a recap just before the summary lists every row that now passes
  or now fails and every kept row; the workflow's step summary prints the
  recap and the summary line. Check every recap line against its document
  before the real run. The repair cannot leave one row alone: while a line is
  wrong, do not run the real repair; fix the rule until it reads that
  document right. Only a `renamed` row can make a withheld filing pass; an
  `added` row can only withhold one (readers then check a name where they
  checked none). It never removes a name readers check, because every entity
  gate (latest_filing.go, picks filings_ingest.go, the dividend estimate's
  ConfirmEstimate) checks an entity only when one is stated: such a row is
  `kept`, left as stored. Six causes, in the order seen on 2026-10-11:
  - a fund manager or responsible entity (Betashares, Vanguard, "The Trust
    Company (RE Services) Limited"): the gate working, nothing to fix;
  - an auditor's letterhead (PwC, BDO Audit): new extractions skip it. An old
    row (12 on 2026-10-13) stays withheld until a rule reads the document's
    own name, and `--repair-document-meta` then renames it; a row whose text
    still yields no name is `kept`, still withheld. This repair never
    publishes it unchecked; a re-extraction (an EMPTY retry,
    `--backfill-digests`, `--repair-echo-digests`) rewrites document_meta
    whole. A subsidiary's accounts stay withheld under the subsidiary's
    name: with the rule that reads the name above a registration number alone
    on its line, AXR's "Sturt Exploration Pty Ltd financial statements" (a
    Core Lithium subsidiary's) read as "Sturt Exploration Pty Ltd", not
    Axiant Resources;
  - a renamed company's results filed under its old code (Conneqt Health's
    under CDX "CARDIEX"): ASX lists them under both codes, and the extractor
    now files a shared document under its owner, the listing that trades
    (`choose_document_owners`), moving older rows at the start of each run
    (`rehome_shared_extractions`, logged as "Moved N extracted documents").
    One still withheld this way is listed under the old code alone, or the
    two codes tie;
  - a listed company whose name ASX has changed: the weekday price sync
    writes ASX's names. One that stays out of date means a second writer.
    Look for its industry flipping in `stock_industry_history`, every change
    at one time of day: on 11 Oct 2026 it was the old GCP project's
    `market-data-sync`, writing a January list at 10:00 UTC;
  - a dead code taken over by a fund (MST "Metal Storm", no price since
    2010, now a Morningstar fund's code): the gate working, since the page
    shows the old company's history;
  - the document is another company's, attached in `financial_reports`: fix the
    linking (`shorted reports link`).
- no summary on the stock page for an extracted results document of the
  newest period: `latest_filing.go` summarises a document only when its own
  period (`document_meta.period_end` folded onto its month end, else its
  report date placed on the balance date) is the code's newest flow period.
  Picks gate 4 reads the same `period_end`, and the dividend estimate's
  ConfirmEstimate counts a results document only when it states the notice's
  period end. A period read wrong at extraction stays in the stored row (VIT's
  FY26 4E kept 2025-06-30, from the prior year's dividend line ahead of its
  reporting-period statement), so `--repair-document-meta` reads the period
  again too, with each row's report date, as every extraction now does. Its
  dry run logs every `period changed`, `period added` and `period kept` row
  with its company, report date, stored and new period, the code's newest flow
  period and the effect on the stock page's check (`becomes the newest
  period`, `was the newest period` or `neither`; that effect is the page's
  alone, and picks gate 4 and ConfirmEstimate read the same `period_end`
  unlabelled), and the recap lists them all: check each against its
  document, as above. `was the newest period` is a document the page
  summarised as the wrong period, withheld until its own period's figures
  arrive. A `period kept` row (the text states no period of its own) is
  never written; removing its period would let readers place the document
  from its report date, a decision to make by hand. The repair never moves
  `extracted_at`, so an `estimated_only` notice waiting on a document whose
  period it writes is read again only at its code's next extraction, or
  after a parser bump. The 2026-10-13 dry run, with this branch's rules: 24
  changed, 15 added and none kept; 17 become the newest period, 4 were (EVO's,
  MGL's and TOK's 1H26 reports and GLS's FY26 4E, each summarised as the
  prior year), 18 neither. NHC's and GNG's FY26 4Es, which state their year
  only as a range, change to their own years, and VIG's FY2025 annual report
  keeps its year (the half it names is one it says is still to be reported).
  Replayed through `selectLatestFiling`, 13 codes gain a summary (VIT and GNG
  among them) and those 4 lose theirs; NHC's page already shows its results
  announcement of the same day.
- `not a results document to the API`: the extractor read a document the Go
  classifier rejects. Make the Python and Go classifiers agree, with a case in
  both test suites.

### Dividend notices: outcomes and failures

`dividend_notice_attempts`, written by `shorted announcements -dividends`
(`services/jobs/internal/jobs/announcements/dividend_*.go`). Outcomes:

| Outcome | Meaning | Action |
|---|---|---|
| `parsed` | rows written; a detail "1 rows; estimate confirmed by <document>; actual amount due <date>" is an estimate its own results document confirmed (parser 6), listed under "Estimates stored from a results document" | none |
| `estimated_only` | only estimated amounts: stored when an update declares the actual, or once the issuer's own results document confirms the same distribution (parser 6) | none until its State is overdue; after its due date the pass reads it again on every new extraction of its listing code with a dividend and a period end, and logs why it is not stored |
| `awaiting_aud_equivalent` | foreign currency, no AUD equivalent yet | none until its State is overdue |
| `no_text` | the PDF has no text | read again after 7 days |
| `code_mismatch` | the notice is for a code that none of the pages listing it shares (a renamed company's notice, listed under its old and new codes, is read under the one it names) | check: a stapled security may need a mapping |
| `scrip_only` | paid only in securities (Part 3C: a scrip or in-specie distribution), so no cash dividend to store; a notice paying cash and scrip stores the cash (BCN) | none; final, like `cancellation` |
| `missing_field`, `inconsistent`, `no_amount`, `not_appendix_3a1` | the parser could not read it | investigate |

The failures list gives each waiting notice a State, from the detail parser 3
records ("ex 2026-10-12; actual amount due 2026-10-19", the date the notice
promises its update by): `stored from a later notice` (its update stored the
dividend: nothing to do), `due <date>`, `overdue since <date>` (look for the
update notice in `asx_announcements`. If the issuer never sends one, parser 6
stores the estimate once its own results document confirms it. The run's log
line `<code>'s estimate ex <date> not stored: <reason>` names the gate that
withholds it: franking not stated; no document stating its period end filed
in the window; no agreed entry naming the period's own distribution; an entry
at another amount or franking; a later notice for the dividend; or a row
stored for its ex-date or period. Decide how to store the amount only when
that reason is wrong), or `no date recorded` (written before parser 3; the
next run reads it again). Overdue notices and every other failure are listed
first.

`Estimates stored from a results document` lists every estimate parser 6
stored. Each is checked again against its code's documents with the pass's
own rule: `confirmed` needs nothing; `no longer confirmed: <reason>` (a
document re-extracted or withdrawn) needs a look; `replaced by a later
notice` needs nothing.

To investigate a notice, read its text as the Go parser reads it, then keep
the text as a fixture:

```bash
cd services/jobs && GOWORK=off go run ./cmd/shorted review -text '<notice url>' \
  > internal/jobs/announcements/testdata/dividend_notices/<code>_<kind>_<yyyy-mm-dd>.txt
```

Add the fixture to `TestParseDividendNotice` with the values the notice states,
fix `parseDividendNotice` or `dividendRowsFor`, and **bump
`dividendNoticeParserVersion`** in `dividend_pass.go`: every failure an older
version recorded is then read again on the next run. The NZ supplementary
dividend (Part 3F) is the worked example: 13 notices were `inconsistent`
because 2A.9's total includes it. Parser 5's are the next: an NZ total that
leaves the supplementary out (AFP), a blank 1.6 security code (the 1.3 issuer
code, never for a notice with a Part 3D), an amount in the estimate field that
the notice answers "Actual" (LED), a text layer that runs fields together
(Storage King), and Part 3C scrip (BCN, VMC).

Parser 6 stores an estimate the issuer's own results document confirms (GMG
lodges one estimate a half and never an update; the gates are at the top of
`dividend_estimate.go`). The entry's label must name the period's own
distribution and no other. Payment dates after the period end are read and
removed first (MGR's "payable on 31 August 2026"; "26.08.2026" and
"15-09-2026" read like "15/09/2026"). It withholds:

- an entry naming a payment on or before the period end (EZZ, TWD, MEC);
- a payment the rule cannot place: a month name or a four-digit year in the
  40 characters after "paid", "payable" or "payment", whatever the words
  between (TBR's "paid to shareholders on 24 November 2025", RMC's "paid (24
  March 2026)", SRH's "to be paid on the 28 September 2026"); a payment in or
  during the year, period, half or quarter; an FY or half label; an ordinal
  day ("paid on the 24th", "payable during the 4th quarter"); or a numeric
  date it does not read. "Paid for" and "paid in respect of" say what was
  paid, not when, and are skipped. So is the class an amount is per ("per
  fully paid ordinary share", "per partly-paid unit", "per ordinary fully
  paid CDI": "per", at most one of ordinary, stapled or preference, "fully",
  "partly" or "partially" paid, hyphenated or not, any of up, ordinary,
  stapled or preference, then share, security, unit or CDI, singular or
  plural), but only when no month or four-digit year follows it within 40
  characters, or the first that does is the period end's own day in a
  period phrase ("for the year ended 30 June 2026", "for the six months to
  31 December 2025"). The 40 characters are counted without what is
  skipped. Before any other date ("per fully paid ordinary share on 24 June
  2026"), and anywhere without "per" ("paid to the holders of fully paid
  ordinary shares on 24 June 2026"), "fully paid" is a payment word;
- an FY or half label ("FY26", "FY-25", "1H25", "H1 25", "2H-25", "1HY26",
  "F25", "H1 F26") other than the document's fiscal year. A half ending July
  to December belongs to FY(year+1), so FY(year) there is the comparative
  half; a document whose period is not stated reads FY(year) only;
- a month with another year's two digits ("Jun-25" in a year to June 2026,
  "Dec '25" in a half to December 2026). Two digits followed by decimals are
  an amount (DXS's "31 December 19.3"), and followed by a year a day ("June
  30, 2026");
- a total, combined, full-year, prior, previous, pcp, comparative or
  corresponding figure, or a forecast;
- a notice when a same-day notice with a larger idsId exists (PCI);
- a notice when the period's dividend is stored under another ex-date (KME,
  KSL, N1H). This also withholds an issuer that states one period end for two
  distributions (LFG), which fails safe.

Still read as the period's own (none of prod's entries on 2026-10-13): an
earlier payment whose date the rule does not read, in the period end's month
when its date is more than 40 characters after its payment word, before it
("On 24 June 2026 the Company paid"), after another verb ("distributed on")
or with no payment word near it ("15.0 cents per share on 24 June 2026"),
and in any month when the date is run together ("paid on 24June2026"); and a
comparative written in a way the rules do not read ("Jun25", "Jun.25",
"30/06/25", "June2025", "F'25", "last half").
Withheld though it is the own distribution: one paid on or before the period
end (TCO's FY26 final, `03143444`, "paid on 30 june 2026"); a later payment
with words between the payment word and its date ("payable to shareholders
on 24 September 2026"); an ordinal day (LOV's "to be paid on 15th October
2026"); a payment in an ordinal quarter ("payable in the 1st quarter of the
next financial year"); a record date, which names a later month ("record
date 3 September 2026"); a payment word that sits next to the period end's
own date for another reason ("payable (cents per share) year ended 30 June
2026", "paid/payable for the year ended 30 June 2026"); a class followed by
a date that is not its period phrase's end ("per fully paid unit for June
2026"), or spelled another way ("per fully paid stock unit", "per share on
fully paid capital"); and two digits straight after a month that are a day
or a whole amount ("August 28", "30 June 15 cents"), read as a year. That
fails safe for the entry itself,
but a withheld entry no longer counts against the estimate: the
no-contradiction gate reads only entries whose label passes, so an own entry
at another amount, withheld, cannot stop a confirmation.

After its due date an `estimated_only` notice is read again on every new
extraction of its listing code with a dividend and a period end. A code with
N waiting estimates costs N reads (two ASX requests each) per extraction,
each failing safe. A document moved by `rehome_shared_extractions`, or whose
period `--repair-document-meta` writes, triggers nothing: neither moves
`extracted_at`. A review flag for a period stored under two ex-dates must
match a re-lodged notice (the same amount), never the period alone.

## 3. Fix

- Build the test from the real document (its text as a fixture, or the stored
  row's shape), and watch it fail before the fix.
- Prod does not run `migrate up`. A new column goes in an allowlisted,
  replay-safe migration (`services/migrations/PROD_APPLIED.md`); a one-off data
  fix is hand-applied with `task db:prod:apply` after the user agrees, and
  recorded there.
- Go: `GOWORK=off`. Python extractor tests: `pytest` in
  `services/report-extractor`; its Postgres tests run with
  `REPORT_EXTRACTOR_TEST_DATABASE_URL` pointed at a throwaway container.

## 4. Verify

The fix is not done when CI is green. After the deploy, wait for the next
scheduled run (`financial-report-extractor` 14:00 UTC, `shorted-announcements`
11:00 UTC) or run the job by hand with the user's OK, then:

- review again: the document should have left its list;
- check what a reader sees: the stock's `GetDividendHistory` /
  `GetStockFinancialHighlights` through the public API, or the MCP tool
  `get_stock_briefing`.

## 5. Record

Add an entry at the top of `docs/data-review/LOG.md`, in the form of the
entries already there: the date, the heading counts, then one line per
document investigated (what failed, why, the fix and its PR), and what was
left alone and why.

Name each document, its cause, and the fix or the reason it was left. The log
is how the next review tells a new problem from a known one.
