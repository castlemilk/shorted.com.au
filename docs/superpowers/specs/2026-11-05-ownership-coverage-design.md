# Ownership coverage: bridging the gaps in the register (2026-11-05)

The hub states the record's coverage honestly: 18,167 notices read, 7,557 withheld and 1,130 set aside of 26,854 documents attempted; 11 index funds tracked of the ETFs on ASX; 11 super fund options of 72 APRA funds. This spec is the programme that narrows each gap, in the order of what each buys, with every figure still carrying its provenance and nothing guessed.

## 1. The record as measured (production, 2026-11-05)

| Outcome | Count | What it is |
|---|---|---|
| no_text | 3,329 | a scanned PDF with no text layer; 1,137 at the retry cap of 3, 2,164 at 2 |
| no_voting_power | 2,976 | 1,923 "change notice without a previous and present pair", 932 "no votes and voting power pair", 87 NZ disclosures without a total, 34 with an odd number of figures |
| fetch_error | 853 | every one "could not resolve PDF URL": ASX answers "Sorry, cannot display PDF." for the id; 587 belong to codes no longer in ASIC's short report (delisted or renamed), 266 to live codes |
| no_holder | 587 | 478 "section 1 names no holder that can be read", the rest placeholders (annexures) |
| ambiguous_target | 530 | a notice listed under several codes whose name the parser could not settle: ZIP CO LIMITED under Z1P/ZIP/ZML (68), ARB Corporation under ARB/ARP (61), a notice naming no company (19) |
| not_a_notice | 277 | never a substantial holding form |
| inconsistent_votes | 87 | the stated votes do not fit the share count |
| implausible | 48 | a figure outside what a notice can state |

Funds: four issuers' holdings files (iShares, Vanguard, SPDR, Betashares; 11 funds), eleven super fund options (one per fund). ASX's investment products report lists 471 ETFs, most holding no ASX equity; APRA lists 72 funds.

## 2. Decisions

### 2.1 An unresolvable notice is set aside, not retried forever

ASX's `displayAnnouncement.do` answers "Sorry, cannot display PDF." for 853 ids, most of them companies ASX no longer lists. The outcome `unavailable` is recorded the first time ASX answers that page (the resolver recognises the error text; a transport failure stays `fetch_error`). An `unavailable` notice is never retried by the nightly, is counted apart ("not available from ASX") in the breakdown, and joins the set-aside figure in the band. A `fetch_error` keeps its 7-day, 3-attempt retry.

Before setting the 853 aside, the job tries ASX's current announcements API once for each (`asx.api.markitdigital.com/asx-research/1.0/companies/<code>/announcements`, the item with the same date and headline, its `documentKey` downloaded from `.../file/<documentKey>`, which serves the PDF). A code the API does not know (delisted) is `unavailable` at once. This is `-mode resolve-unavailable`, run once by hand and then folded into the nightly for new `fetch_error` rows.

### 2.2 An ambiguous target is settled by name, or withheld

A notice listed under several codes names the company in its heading. The parser already compares that name with the companies' names; it fails on suffix and punctuation variants ("ZIP CO LIMITED" against "Zip Co Ltd"). The comparison now folds case, punctuation and the corporate suffixes (Limited, Ltd, Pty, Corporation, Corp, Group, Holdings, NL, Inc) on both sides, and when exactly one of the listed codes is current in ASIC's short report and the name matches it, that code is the target. A notice naming no company, or matching more than one current code, stays `ambiguous_target`.

### 2.3 Withheld notices are read a second time by a model, under the extractor's rules

A notice the parser withholds for `no_text`, `no_voting_power` or `no_holder` is offered to a second reader: the report extractor's consensus (one primary model reads, a checker reads independently, an arbiter decides a disagreement, no majority is withheld), over the PDF's text, or over page images for a scan (the register's vision path, `register_vision.py`). It extracts the holder name, the form, the previous and present voting power (percent and votes), the event date and whether the holder ceased.

Every figure is validated before it is stored, as the director notices are (`director_direct.py`): the stock code must be the listing's; the form must agree with the headline; both percentages must be stated (a change notice states both or is withheld); the votes must fit ASIC's share count as at the notice's date within the parser's own tolerance (the `inconsistent_votes` rule); the holder name must appear in the text (for a scan, both readers must state it alike); a sign or direction contradicting the figures is withheld. A model failure is never recorded as an attempt.

A notice read this way is stored with `read_by = 'model'` (migration `000145_notice_read_by`: `read_by TEXT NOT NULL DEFAULT 'parser'` on the notices and attempts tables, replay-safe, in the deploy allowlist above 000138). The API carries `read_by` on every notice it serves and the overview counts `notices_read_by_model`; the feed marks a model-read notice ("read by model, two readers agreed") and the sources line states the count. A model-read notice never overwrites a parser-read one, and a later parser success replaces a model read.

The pass is `financial-report-extractor`'s new entry point, `notice_direct.py` (`--notices`), budgeted like the filings pass (`--budget-min`, `--limit`), run once as a backfill over the withheld set largest-company first, then nightly over the day's new withheld notices after the parser's run. Its gold set is thirty withheld notices read by hand before the first write (`bench_notices.py`), and the prompt changes only against that bench.

### 2.4 Index funds: every Australian-equity ETF with a holdings file

The universe the hub states coverage against is the Australian-equity ETFs of ASX's report, not all 471. The adapters already read four issuers' files; the fund list grows to every Australian-equity ETF those issuers publish, and new adapters read VanEck and Global X (the catalogue is the research report of 2026-11-05, verified file by file). The overview carries `etfs_australian_equity` beside `etfs`, and the band reads "N of M Australian-equity ETFs tracked".

### 2.5 Super funds: more options, more funds, with the owner's browser

Every option of a tracked fund whose files share one index (Vision's Table 1 names every option) is read; AustralianSuper, UniSuper, CSC, CFS, MLC, AMP and Macquarie publish per-option files behind pages that refuse automated fetches or need a click, so their URLs are recorded by hand (the owner's browser) into `phdSources` before the job reads them. No fetch path evades a refusal.

### 2.6 Later: holders below the threshold

The top twenty shareholders table in every annual report (the report extractor already reads those documents) is a new extraction target, one table per company per year, into its own table. Specified after 2.3 has run and been measured.

## 3. Order

1. 2.1 and 2.2 (Go, no model, no schema): the resolver, the outcome, the name match, `-mode resolve-unavailable`. Run by hand, measured.
2. 2.3 (Python and Go reader side, one migration): the gold set and bench first, then the backfill under a budget, measured against the gold set before the first write.
3. 2.4 (Go adapters) as the research verifies files.
4. 2.5 and 2.6 as follow-ups.

Every step reports what it recovered and what it set aside, in the job's log and on the hub's band.
