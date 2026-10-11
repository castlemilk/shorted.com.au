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
<date>`, `gave up after N attempts`.

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
- `document names "X", not <company>`: the document is about another entity,
  so it is attached to the wrong company in `financial_reports`. Fix the
  linking (`shorted reports link`), not the gate.
- `not a results document to the API`: the extractor read a document the Go
  classifier rejects. Make the Python and Go classifiers agree, with a case in
  both test suites.

### Dividend notices: outcomes and failures

`dividend_notice_attempts`, written by `shorted announcements -dividends`
(`services/jobs/internal/jobs/announcements/dividend_*.go`). Outcomes:

| Outcome | Meaning | Action |
|---|---|---|
| `parsed` | rows written | none |
| `estimated_only` | only estimated amounts (the actual comes in an update notice) | none; the update is parsed when it arrives |
| `awaiting_aud_equivalent` | foreign currency, no AUD equivalent yet | none; same |
| `no_text` | the PDF has no text | read again after 7 days |
| `code_mismatch` | the notice is for another code than the page it was listed on | check: a stapled or renamed security may need a mapping |
| `missing_field`, `inconsistent`, `no_amount`, `not_appendix_3a1` | the parser could not read it | investigate |

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
because 2A.9's total includes it.

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
