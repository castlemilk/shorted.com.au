# Data review log

One entry per review, newest first. How to run a review and what each list
means: `.claude/skills/data-review/SKILL.md`.

## 2026-10-11, after the deploy

Run read-only against prod at 08:37 UTC, after #705's deploy (08:20) and one
notice pass run by hand (08:33, the scheduled job narrowed to MCY's crawl; the
notice pass is never narrowed). Window 90 days.

Counts: 691 newest results documents unread (unchanged; the first 360-document
extractor run is at 14:00 UTC); 310 empty extractions (226 retry due, 84
waiting, 0 gave up: every count reads 1 until a retry runs); 0 unreadable; 120
rows withheld (unchanged); 48 dividend notice failures (30 `estimated_only`,
14 `awaiting_aud_equivalent`, 2 `code_mismatch`, 2 `not_appendix_3a1`). No
notice is left on parser 1 except the 158 parsed.

Checked:

- **NZ supplementary dividends.** `inconsistent` went from 13 to 0, and all 11
  issuers have their notice's row: MCY A$0.136544, SPK 0.064528, AIA 0.054496,
  the test fixtures' figures.
- **Notices awaiting an AUD rate** went from 3 to 14, because notices once
  `inconsistent` or held as multi-part now get as far as the rate. 9 of them
  have a later update notice that parsed (BHP, BGP, CHI ×2, EBO, MCY, S32, SKT,
  SNZ). 5 have no row: DPM, GNE, PAF ×2 and SST.
- **The extractor's queue.** 2,485 documents, 1,652 of them retries. 4,058 of
  the table's 4,362 retry-eligible rows were written on 19 June 2026 between
  01:19 and 08:17 UTC by a bulk run over 2022–2026 results. Those documents had
  text (median 16,000–19,000 characters), but 97% came back with no metrics
  and no digest, so they look like model failures stored as empty. As shipped,
  a retry ranked after first attempts only within its own tier. That put 121
  retries of recent filings ahead of the unread full years of BHP, CBA and TLS
  (ranks 378, 379 and 383 of a 360 run). A retry now ranks after every first
  attempt. Tonight's 360 are then 256 recent first reads and 104 older ones,
  BHP, CBA and TLS at 257, 258 and 262, and no retries. Retries start on the
  third night (RIO 955, DRO 1,024).

Open:

- **The 5 notices with no AUD rate.** SST pays in kina. Check whether DPM, GNE
  and PAF file an update with the rate. If an issuer never does, choose between
  storing the native amount with its currency and converting at the payment
  date's rate.
- **The first retries (about 13 Oct).** Expect `extraction_attempts` 2 on those
  rows and "N of them empty extractions read again" in the run log. Compare
  the next review's empty count.
- Carried from the first review: the results-title false positives, the
  `document_meta` entities, the 53 mid-confidence digests and the
  `estimated_only` ETF notices (now 30).

## 2026-10-11

The first review, run read-only against prod at 07:05 UTC, before the deploy
that adds `extraction_attempts` (000136) and `dividend_notice_attempts.parser_version`
(000134), so every attempt count read "unknown" and every notice "parser 1".
Window 90 days. The counts below use the final rule, in which an extraction
with no metrics and a digest under 0.3 is empty.

Counts: 691 newest results documents unread (599 never read, 92 empty); 310
empty extractions; 0 unreadable; 120 rows withheld (53 digests between 0.3 and
0.6, 2 under 0.3 with metrics, 61 entity mismatches, 4 whose own heading says
they are not results); 42 dividend notice failures (26 `estimated_only`, 13
`inconsistent`, 3 `awaiting_aud_equivalent`).

Fixed in the same branch:

- **The extractor's backlog.** 691 companies, BHP (filed 18 Aug), RIO, CBA,
  WES, FMG, TLS and WOW among the largest, behind 258 documents filed in the
  last 45 days. #703's tier rule ranks them from the 11 Oct run; at `--limit`
  360 (was 120) the whole list is reached in about three nights, not eight.
- **Empty extractions were never read again.** 129 rows with no metrics and no
  digest (median 7,909 characters, so the text was there), and 181 more with no
  metrics and a digest under 0.3, which neither the picks filings nor the
  latest-filing summary read (147 of them annual reports, whose first 8 pages
  are letters). The 92 unread companies above include RIO's half-year and the
  annual reports of SIG, PLS, LYC, WTC, TLC, ASX, CAR and NXT. Each is now read
  again at up to 24 pages, twice at most, a week apart.
- **NZ supplementary dividends.** All 13 `inconsistent` notices (AIA, BGP ×2,
  EBO, FRW, MCY ×2, MEZ, NZM, SKT, SPK, THL, TRA) are NZ issuers whose 2A.9
  total includes the Part 3F supplementary. Parser version 2 reads it; every
  version-1 failure is read again on the next run.
- **The old headline parser's 91 dividend rows** (wrong ex-dates, cents read
  as dollars, two duplicates): deleted by 000135, kept in
  `dividend_history_headline_rows`.

Open, for the next change:

- **Results-title false positives.** Both classifiers (`extraction_trust.is_results_document`,
  `extractiontrust.IsResultsDocument`) accept "FPH to announce half year
  results on 26 November 2026", "Extension of Time to Hold AGM and Dispatch
  Annual Report" (VAU), "Annual Report Clarification" (PRO), "Correction to
  ASX Additional Information in Annual Report" (RC1), "Annual Report FY2026 -
  Additional ASX Information" (NVA) and "Highlights of the Annual Report for
  FY 2026" (KLV). Each costs a paid extraction, and the digest model rates them
  0.2. Under the new rule they are also empty, so each would be read twice more
  until the classifier rejects them. Fix both classifiers and the shared
  `pkg/extractiontrust/testdata/results_titles.json`.
- **`document_meta` entities that are not the company** (61 rows): "ACN 000
  689 216 |" (ALK), "Limited" (PAC), a street address (KLV), and trusts whose
  documents name the responsible entity ("The Trust Company (RE Services)
  Limited" for MRE and MXT, Ausbil for DIV). The latest-filing summary drops
  every one. Tighten the entity span in `document_meta.py` and decide how a
  trust's responsible entity should match. MST's company name reads "Metal
  Storm" while its filing is Morningstar's: check that code's metadata.
- **53 digests between 0.3 and 0.6** have metrics the API serves but no
  summary. Sample them against their documents before touching the gate.
- **26 `estimated_only` notices**, mostly ETFs (STW, SFY, SLF, RSM, DXI, DXC,
  MXT, MOT). Next review: check that their actual amounts arrived in update
  notices and parsed.
