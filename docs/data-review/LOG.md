# Data review log

One entry per review, newest first. How to run a review and what each list
means: `.claude/skills/data-review/SKILL.md`.

## 2026-10-11, after #708's deploy

#708 deployed at 23:08 UTC. The validation run (`shorted-announcements-g6fq5`,
23:47 UTC, `-codes MCY -years 2026 -dividends`, parser 4) selected 200
notices and parsed 82. `code_mismatch` went from 5 to 0: RIV 0.018 (ex 15
Oct), MSV 0.02 (ex 31 Aug) and AMI 0.01 (ex 16 Sep), all fully franked, read
from the notices listed under D2O, DTQ and YTC. The two listed under NNC are
News Corp's, now read under NWS and stored from a later notice. Rows from
notices: 556 across 455 codes (488 across 429 before).

Review at 23:51 UTC, after the 14:00 UTC extractor run:

- **Newest results document not read: 474 companies** (694 at 13:00). The
  run read the 16 largest (BHP, BXB, CBA, COL, FMG, IAG, ORG, QBE, REA, RMD,
  SCG, STO, TCL, TLS, WES, WOW); the next by size (PLS, LYC, WTC, VCX, TLC,
  SGP, ASX, CAR and others, filed 10 to 27 Aug) rank in tier 1 by market cap.
  Nothing to fix.
- **Empty extractions: 370** (231 retry due, 81 waiting, 1 gave up, 57 not
  results documents). The one that gave up is State Street's SPDR annual
  report (`idsId=03131257`, 190 characters of text), read three times in one
  run under SFY, SLF and STW: the double listing #709 fixes. Nothing to do.
- **Rows the API withholds or trims: 72** (56 at 13:00): 60 by the entity
  check, 9 not results documents, 3 under the confidence gate. The renamed
  companies' rows (CDX, HTG, IRX, MDR, SOV, ST1, CAG, ENN, MKT) move to their
  current codes in #709's first run; AEM's clears with the 12 Oct name sync.
  Fund managers, responsible entities and auditors' letterheads are the gate
  working. Two are cleaning misses, open (below): SEK's entity is an address
  with the state in full and a comma ("60 Cremorne Street, Cremorne,
  Victoria, 3121"), and BWF's is the Appendix 4E label "over which control
  was gained or".
- **Dividend failures in the window: 118** (16 to look at, 90 stored from a
  later notice, 12 waiting). New to look at, all open (below):
  - AFP `inconsistent`: an NZ notice whose 2A.9 total (NZD 0.025) excludes
    the Part 3F supplementary (NZD 0.00441176). Parser 2 assumed the total
    always includes it, as in the 13 notices it fixed.
  - LED `estimated_only`, overdue since 26 Aug: its update (`03130573`, 26
    Aug) leaves 1.6 ASX +Security Code blank, so it failed as
    `missing_field: security code` under ECF, LED's old code. ASK's update is
    the same (blank 1.6, issuer code SKG, Storage King Group). The 1.3 issuer
    code is stated on both.
  - BCN `inconsistent`: $0.10 cash, fully franked, plus about $0.11 of
    Forrestania Resources shares in specie (Part 3C, estimated). The parser
    reads no Part 3C, so the cash dividend is withheld too. VMC `no_amount`:
    a distribution in specie only (0.1212 shares a share, AUD 0.046961).
  - RGB, RG1, LF1: `not_appendix_3a1`, nothing to do.
  - LRT, GNE, SST: overdue as before, withheld as agreed.

Open (each needs the user's OK):

- **Entity cleaning:** `notANameREs` (Go) and `clean_entity` (Python), one
  fixture: a state in full with a postcode ("Victoria, 3121"), and the
  Appendix 4E label "over which control was gained or lost".
- **Notice parser 5:** accept a 2A.9 total with or without the Part 3F
  supplementary; take the 1.3 issuer code when 1.6 is blank.
- **Distributions in specie:** store BCN's cash part and leave the shares out
  of dividends (recommended: a yield should be cash), or store them as their
  own type; either way VMC's notice is not a failure.

## 2026-10-11, company names and shared documents

The two items the entry below left for the user, who said to fix them.
Everything here was measured read-only against prod between 16:45 and 17:30
UTC, except the one trigger paused.

**Out-of-date names of listed companies: a second writer.** The weekday price
sync (`shorted-price-sync`, 10:00 UTC) upserts every name, industry and market
cap in ASX's list (`asx-stocks/latest.csv`, written weekly and current), and
logged "Synced 1834 companies" every day. Yet AEM, PDI, WEB and 12 other listed
codes kept names ASX dropped weeks ago, and `stock_industry_history` showed
AEM's industry flipping between Materials and "Class Pend", every change
stamped 10:00:17 to 10:00:40 UTC. The old GCP project `shorted-dev-aba5688f`
still had its Cloud Scheduler triggers enabled. Its jobs all fail ("Image
... not found"), but its `market-data-sync` service still ran at 10:00 UTC
every weekday (`market-data-sync-daily`) against the prod database (same host,
user and database), upserting the 1,858 companies of its own bucket's
`latest.csv`, a copy of 2 Jan 2026 (AEM "ADVANCED ENERGY MINERALS LTD", Class
Pend, 333,069,333, exactly the prod row). Whichever upsert landed last won. That
trigger is paused (`gcloud scheduler jobs resume market-data-sync-daily
--location australia-southeast1 --project shorted-dev-aba5688f` undoes it;
nothing in prod depends on it). The next price sync, 12 Oct 10:00 UTC, writes
the current names: 15 listed codes change (AEM Advanced Engineered Materials,
PDI PDI Gold, WEB WebBeds Group, LEL LE Minerals, PLC PLC Resources, AZ9 Azzuro
Resources, H2G, KLV, MHC, NRL, YAR, MEI, ZMI, ATM, 3DA), 7 industries, and 3
codes with no row are added. The project's 15 other triggers are left alone:
13 start jobs whose image is gone, and `stock-price-daily-sync` and
`stock-price-weekly-sync` (08:00 weekdays, Sundays 10:00) call its own
`stock-price-ingestion`, which fails before it writes (`self.pool` is None).
Prod's triggers of the same names call prod's `stock-price-ingestion`
(us-central1), whose code writes `stock_prices` and its own logs, never
`company-metadata`.

The other names in the entry below are not wrong for what the site shows:
- The renamed companies' old codes (CDX, MDR, SOV, ST1, HTG, IRX) keep the old
  name. Their new codes hold the new one, and what went wrong was where the
  documents were filed (below).
- The codes taken over by funds (MST, TOL, BEM, BND, MTU, GGB, EXU, AGX, BDC,
  CGH, CIE, IMP, MOG, PGA, PGI, CIM, PAX) have had no price and no short
  position since 2010 to 2022. The name is the company whose history the page
  shows, and the fund's documents attached to the code stay withheld by the
  entity check.
- IFG's name matches ASX's list.

**Shared documents: read once, filed under the current code** (this branch).
4,101 results documents are listed under more than one code. Each now has one
owner (`choose_document_owners`). The owner is the listing priced within 7 days
of the newest; failing that, the one on ASIC's short report within 30 days;
then the largest by market cap; then the first code. Only the owner's copy is
selected. At the start of each run, a row filed under an out-of-date listing
moves to the owner (`rehome_shared_extractions`). A listing is out of date
when it is behind on prices, or behind on short reports while both carry the
same last three closes (Yahoo still serves HGO, GRL, MTC and C1X with the
prices of KAN, OBT, GGM and EAU) or neither has current prices. Funds that all
trade are not moved: VAP has not been on ASIC's report since May, but it
trades. A dry run on prod lists 290 moves (31 with figures, 164 code pairs):
SW1→STV, CDX→CQT, HTG→NS1, MDR→AHE, MKT→GUM, ST1→ITS, CPB→ALQ, PXS→SNT, and
more like them. Of the 31 with figures, 29 are renames; the other two are a
fund manager's report moving from a code with no current price to a fund that
trades (OZF→OZR, GMV→MVA). 20 moves drawn at random were the same two kinds.
The selection for the next run has no document twice in its 360.

Open:

- **After the 12 Oct price sync (10:00 UTC):** the 15 names above, and AEM's
  industry history should stop flipping.
- **After the first extractor run with this branch:** the log line "Moved N
  extracted documents to the listing that owns them" (about 290 the first
  time, then few), and the withheld list should lose the renamed companies'
  results (CDX's, MDR's, SOV's, ST1's, HTG's and IRX's now sit under CQT, AHE,
  CYB, ITS, NS1 and NX1, whose names match).
- **The old project's other triggers** are still enabled. Every one of them
  fails before it writes, so they do no harm, but whether to pause or delete
  them, or the project, is the user's call.
- **The three overdue dividends** (LRT, GNE, SST) stay withheld, as
  recommended in the entry below.
- **The first retries (about 13 Oct)**, as in the entries below.

## 2026-10-11, after #707's deploy

Run read-only against prod at 13:01 UTC, after #707's deploy (12:57) and one
notice pass run by hand (12:57, `shorted-announcements-24nbz`). Window 90
days.

Counts: 694 newest results documents unread (the first 360-document extractor
run is at 14:00 UTC); 362 empty extractions (204 retry due, 101 waiting, 0
gave up, 57 not results documents); 0 unreadable; 56 rows withheld; 89
dividend notice failures (14 to look at, 63 stored from a later notice, 12
waiting for their update).

Checked:

- **Parser 3.** The pass selected 200 notices and parsed 111, writing 87 rows
  (488 rows from notices in all, across 429 codes). It read every parser-2
  failure again, and each of the 78 notices waiting on an update now records
  the date its update is due. The 12 still waiting are due between 12 Oct
  (MA1, REV) and 19 Nov (PAF ×2).
- **The 3 overdue notices are late at the issuer.** ASX's own announcement
  lists match the crawl. LRT's 31 Jul update ("Dividend reinvestment price
  finalised") still gives its A$0.1432 only as the estimate (3A.1a), with the
  actual amount (3A.1b) blank, on the day it was paid; ASX lists nothing
  later. GNE's AUD rate for its NZD 0.0892 was due 9 Oct, and it has filed
  nothing since 7 Oct. SST's rate for its PGK 0.35 was due 2 Oct, and it has
  filed nothing since 31 Aug.
- **The other 11 to look at:** 4 `not_appendix_3a1` (RG1, LF1 ×2, VG1), 2
  `missing_field` "security code" (ASK's, and the LED notice of the entry
  below, now recorded under ECF: ASX lists it under both) and 5
  `code_mismatch`.
- **The 14:00 UTC extractor run** (`financial-report-extractor-wvk8b`, the
  first at 360) selected 360 documents, none of them retries, and finished in
  17.8 minutes: 338 ok, 18 digest only, 4 no metrics, no model errors, about
  US$1.23. BHP, CBA and TLS were read at 14:12–14:13, and each one's FY26
  result is now its latest filing on MCP's `get_stock_briefing` (CBA: revenue
  $30,153m, NPAT $10,866m).

Fixed in the same branch:

- **The 5 code mismatches were ours.** ASX lists each of these notices under
  two codes, as it lists a renamed company's announcements under its old code
  and its new one: RIV's under D2O and RIV, MSV's under DTQ and MSV, AMI's
  under YTC and AMI, NWS's and NWSLV's under NNC and NWS. The pass read each
  PDF once, under one listing, and withheld the notice when that listing was
  the other code. 435 of the 5,724 dividend notices crawled are listed under
  two codes (NNC/NWS 24, HHV/PIA 22, ECF/LED 21, DXI/IDR 20, WDS/WPL 10,
  D2O/RIV 10, ...), and the backfill, newest first, had reached 14. The pass
  now reads a notice under the listing whose code it names (`listedAs`;
  NWSLV's under NWS, by rule 1's first three characters), and parser 4 reads
  the mismatches again.

Open:

- **Three dividends whose update is overdue at the issuer** (LRT, GNE, SST).
  The pass withholds them and the review lists them first. Storing them would
  mean taking an estimate as paid (LRT) or converting at a rate of our choosing
  (GNE, SST): a decision for the user, not a parser fix.
- **The extractor has the same double listing.** It picks one document per
  code, so a document listed under two codes is read once for each, and the
  first write keeps the row (`report_url` is unique; `stock_code` is not
  updated on conflict). The 14:00 run read 19 documents under two to four
  codes (22 extra reads), and each of those rows starts at 2 to 4 attempts.
  6 of them are now filed under the old code of a renamed company, so the
  current code has no row: STV's under SW1, KYN's under ENN, PFM's under CAG,
  VHL's under RSH, GUM's under MKT, NS1's under HTG. Over all time, 4,630 of
  the 36,603 documents of the five results types are listed under more than
  one code; 943 of them are extracted, and 254 of those are filed under a
  code that is not on ASX's list of listed companies while a listed code
  shares the document (33 with figures). In all ten pairs checked, the
  current code is the one with the latest price in `stock_prices` (9 Oct;
  the old code's prices stop at the rename or never start), where market cap
  would pick the old code for 591 documents. A fix: read a document once per
  run, under the listing with the latest price, and move the misfiled rows to
  the current code (a prod data change). It belongs with the out-of-date
  company names, which need the user.
- **The first retries (about 13 Oct)**, and **out-of-date company names**: as
  in the entry below.

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

Followed up the same day (the carried items):

- **Results-title false positives.** Every candidate title on prod (36,962
  accepted, 5,102 rejected) was tested against the classifier, and each
  suspicious word against what its extracted documents yielded. Both
  classifiers now reject notices about a release (notifications, advance
  notices, release dates, timing, call and teleconference details, scripts,
  "X to announce"), notices about a report's lodgement or dispatch (delays,
  extensions of time, late lodgement, waivers, "update on"), supplements
  (addenda, additional ASX information, supplementary information,
  clarifications) and letters to holders: 658 candidate documents, of which
  84 had been extracted, 2 with figures (BGP's addendum, whose half-year
  results are a separate filing, and a CTD status update). Corrections stay:
  4 of the 19 extracted carried the report's figures, and TYR's FY25 annual
  and EDV's H1 FY26 reached prod only as re-lodged corrections. Proxy and
  Appendix 4G titles stay too: they are the annual report bundled (18,000 to
  28,000 characters), and the 24-page retry is what reads them. The first
  review was wrong about KLV: its "Highlights of the Annual Report" carried
  the result at confidence 0.95.
- **The 53 digests between 0.3 and 0.6** were not rows with metrics: 52 of 53
  had none. They are annual reports read from their opening letters, and
  59 of the 74 figures they quote appear in the 8 pages read. With no
  metrics only the latest-filing summary reads a row, and only at 0.6 or
  more, so these summaries reached no reader and were never read again. The
  empty rule now uses 0.6 (`USABLE_DIGEST_MIN_CONFIDENCE`): 52 more rows
  (33 due now) join the retries. The API's gate is unchanged.
- **The 30 `estimated_only` notices** all resolve on their own: 21 have a
  later notice with the actual amount, parsed and stored; the other 9 state a
  date for the actual amount between 12 Oct and 11 Nov. Parser 3 records the
  ex-date and that date in the attempt's detail, and the review now gives each
  waiting notice a State: stored from a later notice, due, overdue, or no date
  recorded (until parser 3 reads it again on the next run).
- **`document_meta` entities.** 74 recent entities failed `EntityMatches`: 16
  were not names, or a name run into an address ("ACN 000 689 216 |", "ASX:
  TLM |", a web or email address, a street address, "Limited", "ANNUAL
  REPORT", "Klevo Group Ltd |Suite 102, ..."); 12 were an auditor's letterhead
  (PwC, BDO Audit, Grant Thornton Audit, Moore Australia Audit, RSM); 36 named
  a fund manager or responsible entity instead of the fund; 8 were renamed
  companies whose `company-metadata` name is out of date; 2 were the same name
  written differently. One set of cleaning rules (Go `cleanEntity` on every
  read, Python `clean_entity` on write, one fixture) drops the non-names and
  reduces letterheads ("Klevo Group Ltd |Suite 102, ..."); new extractions
  skip an auditor's ABN and name a trust from "<RE> ABN ..., the Responsible
  Entity of <trust>";
  `EntityMatches` matches the same name however generic or spaced ("Energy
  Technologies", "Echo IQ" / "Echoiq"). 18 of the 74 now read correctly, 15
  of them with figures. Auditor rows stay withheld: AXR's two "Sturt
  Exploration Pty Ltd financial statements" are a subsidiary's accounts, and
  the auditor's name was what kept them off AXR.
- **The review's empty list** now marks the 57 empty rows whose title the
  classifier rejects as "not read again": the extractor never offers them.

The scheduled 11:00 UTC announcements run (parser 2, before #707's deploy)
selected 200 notices and parsed 176, writing 120 rows: 401 rows from notices
in all. Its one new kind of failure, `missing_field` "security code" for LED's
"Update - Dividend/Distribution" (26 Aug, entity LDR Capital Property Fund),
is the notice's own blank: field 1.6 and the summary's security line are
empty, so skipping it is right. The screener's view, refreshed at 10:00,
reads FML 0.08, VMC 0.1697 (was 35.0), RPL 0.12 (was 0.27), CBA 2.70, BHP
1.379887 and MCY 0.136544 (each 0 before); no stock's trailing dividend is
over $5.

Open:

- **The 5 notices with no AUD rate.** Each states when the rate will come
  (2A.9b): DPM 15 Oct, PAF ×2 19 Nov (the first says ZAR 65.00, a typo its
  next-day update corrects), GNE 9 Oct (its newest crawled announcement is
  7 Oct), SST 2 Oct (nothing crawled since 31 Aug, normal for SST). Only one
  whose rate never comes needs a decision.
- **The first retries (about 13 Oct).** Expect `extraction_attempts` 2 on those
  rows and "N of them empty extractions read again" in the run log. Compare
  the next review's empty count.
- **Out-of-date company names.** `company-metadata` keeps the name of a
  company that was renamed (CDX "CARDIEX" is Conneqt Health, MDR "MEDADVISOR"
  is Adheris Health, SOV, ST1, HTG, IRX, IFG, AEM) or whose code was reused
  (MST "Metal Storm" is a Morningstar fund; TOL, BEM, BND, MTU, GGB and EXU
  are Betashares funds; AGX, BDC, CGH, CIE, IMP, MOG, PGA, PGI, CIM, PAX). The
  renamed companies' own results are withheld by the entity check, and every
  page shows the old name. Find the job that writes `company_name` and make it
  follow ASX's list; check with the user first, since names change site-wide.

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
