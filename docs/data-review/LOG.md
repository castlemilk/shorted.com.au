# Data review log

One entry per review, newest first. How to run a review and what each list
means: `.claude/skills/data-review/SKILL.md`.

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
