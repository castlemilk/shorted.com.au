# Data review log

One entry per review, newest first. How to run a review and what each list
means: `.claude/skills/data-review/SKILL.md`.

## 2026-10-13, after #711's deploy and its repair

#711 merged at 01:41 UTC (`bbe54dc63`) and its deploy finished at 02:25 UTC.
terraform-apply put the announcements job and the extractor on
main-bbe54dc6. On the deploy alone, the API reads 3 stored rows differently:
KYN's `03132171` (still withheld), WLD's `02987859` (a sentence fragment
dropped; still published) and SWM's `02979174` (a phone number dropped; its
FY25 4E is now published).

- **The repair as a dry run**, on the deployed job
  (`financial-report-extractor-8k2tt`, 03:10 UTC). Its 56-line recap is
  identical, in order, to the local dry run's.
- **The real run** (`financial-report-extractor-thn8l`, 04:16 to 04:19 UTC,
  after the user's OK) logged the same summary: 1,983 rows read; entities
  1,350 unchanged, 62 cosmetic, 14 renamed, 552 added, 5 kept; periods 1,944
  unchanged, 24 changed, 15 added; 0 left alone.
- **Checked row by row** against read-only snapshots of the 1,983 rows, taken
  before and after. 658 rows changed, each exactly as the rule decides, and
  the other 1,325 are as they were. No `extracted_at` moved. 16 of the 62
  cosmetic rows lost a stored non-name ("ANNUAL REPORT", "ASX: TLM |", an
  address) that readers already read as none. A dry run after it
  (`financial-report-extractor-pv7vw`) finds nothing to change except the 5
  kept auditors' names (MAE, MCC, CP8, ROG, ETM).
- **What a reader sees.** extractiontrust's reader, over the rows after the
  run, changes its verdict on exactly the recap's ten: EMH, IFG, SRJ, VIT and
  WEL are now published, and EAR, JHG, JHL, MRE and SFI withheld. The stock
  page's latest filing, replayed over the 628 codes written, matches the
  prediction for every code: AVE, BVS, CAA, CGS, CMB, FMG, GNG, IGO, PPS, PRU,
  QFE, SGR and VIT gain a summary, and EVO, GLS, MGL and TOK lose theirs. MCP
  `get_stock_briefing` serves VIT's FY2026 4E (revenue up 5.7% to $131.2m, a
  net loss of $4.4m), BP8's FY2026 annual report under its new name, NHC's
  year to 31 July 2026 and GNG's FY26 accounts. AXR and VIG show none, as
  before. GMG's FY26 4E (`03127287`), which confirms its estimate, is
  unchanged.

Review at 04:24 UTC:

- **Newest results document not read: 266 companies**, unchanged: there has
  been no extractor run since.
- **Empty extractions: 374** (255 retry due, 62 waiting, 1 gave up, 56 not
  results documents). CNU's `03114543` (14 Jul) left the 90-day window.
- **Unreadable documents: 2** (NAN and HMY), unchanged.
- **Rows the API withholds or trims: 64.** EMH, IFG, SRJ, VIT and WEL left,
  and EAR, JHG, JHL, MRE and SFI joined. All five were published only because
  no entity was stored.
  - EAR, JHG, JHL and SFI join the codes taken over by funds (11 Oct,
    "company names and shared documents"). Each fund trades under a longer
    code (EARN, JEGA and JHGA, JHLO; SFI's is not in our data), and that code
    has the prices. ASX files the fund's announcements under the three-letter
    code, and `asx_announcements` holds no longer code (2,629 codes). The
    three-letter code has no price, and its company (Echo Resources, Janus
    Henderson, Jayex Healthcare, Spookfish) last appears in ASIC's short
    report between 2015 and 2024. The page shows that company's history, so
    its name is right and withholding the fund's report is correct. It is not
    a fix to the names.
  - MRE's (`03144652`) is its own Listing Rule 4.3D letter, on its responsible
    entity's letterhead: "The Trust Company (RE Services) Limited ... in its
    capacity as responsible entity of the Metrics Real Estate Multi-Strategy
    Fund (ASX: MRE)". The entity was read from the letterhead. 39 of the 64
    withheld rows name a fund's responsible entity, manager or issuer
    (Betashares 8, Equity Trustees 5, Russell 4, The Trust Company 4). How a
    trust's responsible entity should match is still open (11 Oct).
- **Dividend failures in the window: 144**, unchanged: there has been no
  notice run since. Estimates stored from a results document: 0. Parser 6's
  first run is the 11:00 UTC announcements run.

Parser 6's first run (`shorted-announcements-8z7fz`, 11:00 to 11:30 UTC, on
the #712 image, whose jobs code is #711's): 200 notices read, 46 parsed (38
rows); 103 estimated only, 40 awaiting an AUD equivalent, 9 not an Appendix
3A.1, 1 missing a field, 1 with no text.

- **GMG's `03104557` is stored**: AUD 0.15 ordinary, 0% franked, ex 29 Jun,
  period end 30 Jun, attempt "estimate confirmed by `03127287`".
- **LRT, GNE and SST stay withheld**, with no rows. LRT's newest estimate
  (`03120710`): "no agreed entry in results document names ordinary
  distribution period ending 2026-06-30". Its three earlier ones each give
  way to the next. GNE and SST still await their AUD equivalents.

Review at 11:33 UTC:

- **Estimates stored from a results document: 1**, GMG's, confirmed by the
  quote "Final dividend and distribution proposed per GMG security (cents)
  15.0".
- **Dividend failures in the window: 154** (17 to look at, 127 stored from a
  later notice, 10 waiting). The window counts by when a notice was last
  read, and the parser bump re-read June notices:
  - GMG's estimate left.
  - Five June estimates joined, each superseded by a later notice that
    stored the same dividend: CIA, DN1, OPH, QRI and RFF.
  - Six joined the list to look at: ASK `03104198` gave no text (no text
    layer, or a failed download; it is read again after 7 days), ATM
    `03103847` is missing its total, and KIT's (`03098641`, `03103276`) and
    REV's (`03098449`, `03102805`) are not Appendix 3A.1 forms. #711 did not
    change those checks.
- **Newest results document not read: 265.** WTC left without being read.
  WiseTech filed its 2026 Annual Report (`03151512`) today, and the review
  waits 7 days before listing a newest document. Its FY26 4E (`03130193`)
  was read on 6 Sep with no figures.
- Empty extractions 374, unreadable 2 and withheld 64, all unchanged.

Open:

- After the 14:00 UTC extractor run: the first empty retries, and WTC's
  annual report read.
- After the 15:00 UTC picks run: VIT's FY26 figures in `stock_fundamentals`.

## 2026-10-12, after #709's first extractor run

The 14:00 UTC run (`financial-report-extractor-h98nt`, 14:00 to 14:20 UTC,
main-ba8f446a) was the first with #709's document owners. It logged "Moved
281 extracted documents to the listing that owns them", then read 360
documents: 325 `ok`, 20 `digest_only`, 14 `no_pdf` and 1 `no_metrics`, with
no model errors, for US$0.50.

- **Moves.** 281 of the 290 the dry run listed now sit under their owner.
  They include SW1→STV (3), CDX→CQT (2), HTG→NS1 (4), MDR→AHE (2), MKT→GUM (2)
  and ST1→ITS (3), and every one of the 28 code pairs with figures. The other
  9 have no figures. They are the price-twin pairs HGO→KAN (2), GRL→OBT (3),
  MTC→GGM (2) and C1X→EAU (2). The 12 Oct price sync gave only the new codes
  a 12 Oct close, while the old codes stop at 9 Oct. Their last three closes
  no longer match, and both listings are still within 7 days of the newest
  price. If the old codes get no more prices, these move on the 19 Oct run. A
  dry run after the run lists 0 moves.
- **What a reader sees.** MCP `get_stock_briefing` gives STV its FY26 annual
  report (28 Aug), read today under STV, with the 4E moved from SW1 beside it.
  It gives CQT its 2026 annual report (30 Sep), moved from CDX. Both carry a
  summary. SW1 and CDX hold no rows now.
- **No PDF: 14.** ADV, ASK, EEG, GLV, HTG, IPL, IXU, LBT, LV1, MZZ, OAU, OPT,
  SQ2 and SVW: documents filed in 2023 whose ASX page gave no PDF link,
  for the document and for its fallback. A failed fetch stores no row, so
  they come back every run. Each costs no model call, but together they take
  14 of the 360 places.

Review at 14:40 UTC:

- **Newest results document not read: 266 companies** (474 before).
- **Empty extractions: 375** (255 retry due, 62 waiting, 1 gave up, 57 not
  results documents). The run read no retries: retries come after every
  first attempt, and first attempts filled all 360 places. The 13 Oct run
  should reach them.
- **Unreadable documents: 2** (0 before): NAN's (`03129302`) and HMY's
  (`03127789`) have no text layer.
- **Rows the API withholds or trims: 64** (69 before). The renamed companies'
  rows left as expected (CAG, CDX, ENN, HTG, IRX, MDR, MKT, SOV, ST1), and ECF's
  and OZF's with them. Three of these 11 moved and stay withheld under the new
  code, because the document names a trustee or a stapled entity rather than
  the listed company:
  - KYN (`03132171`): "Kyron Investment Fund", moved from ENN;
  - LED (`03144860`): Evolution Trustees, moved from ECF;
  - OZR (`03131288`): State Street, moved from OZF.

  Three more are new reads from this run. GCI's names its responsible entity
  (One Managed Investment Funds), and GDF's names Garda Capital Limited, one
  of Garda Property Group's stapled entities. VIT's (`03130179`) is Vitura
  Health's own Appendix 4E. Its entity was read from the 4E's "control gained
  or lost" section: "Cortexa Pty Ltd", a joint venture deconsolidated on
  1 July 2025. That is the same family as BWF's 4E label, fixed in #710.
  Fixed below.
- **Dividend failures in the window: 144**, unchanged: there has been no
  notice run since the last review.

Fixed on this branch (the user said "we need grounding truth" for VIT, and
for GMG to go with the recommended option):

- **Where a document's entity and period are read from** (`document_meta.py`;
  the name rules are shared with `extractiontrust` through one fixture). A
  "Name of entity" field under a control gained or lost, associates or joint
  ventures heading is another entity's and is skipped (VIT's "Cortexa Pty
  Ltd"). A name over a registration number alone on its line ("Vitura Health
  Limited / ACN 629 071 594") is read, except under or after a role
  ("Trustee: Perpetual Trust Services Limited"). A former name stays after the
  current name ("Ocean Sciences Ltd (formerly BPH Global Ltd)") unless that is
  a Pty Ltd's, and a former-name bracket alone states no name. The period is
  the document's own reporting-period statement, a range of one half or one
  year included (NHC's "Current period / From 1 August 2025 to 31 July 2026").
  Without one it is the latest period the document names that ended before
  its report date, skipping comparisons and periods it says are still to be
  reported; a document lodged more than 7 months after every period it names
  takes the one it names most (VIG's FY2025 annual report). VIT's FY26 4E now
  reads "Vitura Health Limited", 2026-06-30.
- **`--repair-document-meta`** (the Report Extractor Repair workflow,
  `repair=document-meta`, dry run by default) reads every stored row's entity
  and period again from its stored text, with its report date, and writes
  only those keys. It never removes a name readers check or a stated period,
  and never moves `extracted_at`.
- **Notice parser 6.** An `estimated_only` notice is stored once the issuer's
  own results document for the notice's period end states the same amount
  and franking in an entry whose label names that period's own distribution
  and no other, and no agreed entry states another amount. GMG's FY26 4E
  (`03127287`) confirms AUD 0.15, unfranked, ex 29 Jun, paid 26 Aug. The
  review lists every estimate stored this way.
- **Checked against prod, read-only:**
  - The repair's dry run selects 1,983 rows. Entities: 552 added, 14 renamed,
    62 cosmetic, 5 kept. The entity check now passes 5 (EMH, WEL, IFG, SRJ,
    VIT) and now fails 5 (EAR, SFI, JHG, JHL, MRE). Periods: 24 changed, 15
    added, each read against its document; VIG keeps its FY2025 year.
  - Stock pages: 13 codes gain a filing summary (AVE, BVS, CAA, CGS, CMB,
    FMG, GNG, IGO, PPS, PRU, QFE, SGR, VIT). EVO, GLS, MGL and TOK lose theirs:
    each was a later document summarised as the prior year.
  - Picks: 2,555 accepted filing figures (2,505 before) in 1,167 rows (1,150),
    none removed. VIT's FY26 revenue (131,158,015) and net loss (4,392,015)
    are accepted.
  - Parser 6: the label gate accepts 189 (entry, type) pairs of the 568
    agreed dividend entries in the 365 documents that state a period end.
    Replaying the 199 notices the next run selects changes only GMG's
    `03104557`, now stored; LRT stays withheld.
- **Not on this branch:** picks reads a range label by its first day. GNG's
  FY26 revenue ("financial year ended 1 July 2025 to 30 June 2026") was
  accepted into FY2025; after the repair it is withheld instead.

## 2026-10-12, after #710's deploy

#710 deployed at about 03:11 UTC; the jobs and the shorts API run
main-ba8f446a. The scheduled 11:00 UTC run (`shorted-announcements-smn62`,
11:00 to 11:29 UTC) was the first with parser 5. It selected 200 notices,
the 118 failures of earlier parsers and 82 never read before (filed 16 Jun to
12 Oct), and parsed 55. The five notices #710 fixed changed as intended:

- LED 0.01625 unfranked, ex 30 Jun, from its update (`03130573`), which had
  failed as `missing_field` under ECF.
- SKG 0.031 25% franked, ex 30 Jun, from Storage King's update (`03125139`,
  listed under ASK).
- AFP A$0.020153 (NZD 0.025), ex 18 Jun.
- BCN 0.10 fully franked, ex 13 Jul.
- VMC's distribution in specie (`03111853`) is `scrip_only`.

No notice is `inconsistent`, `missing_field` or `no_amount` any more. Rows
from notices: 604 across 474 codes (556 across 455 before), 48 of them new.

Review at 11:41 UTC, before the 14:00 UTC extractor run:

- **Newest results document not read: 474 companies**, unchanged: the
  extractor has not run since the last review.
- **Empty extractions: 369** (230 retry due, 81 waiting, 1 gave up, 57 not
  results documents).
- **Rows the API withholds or trims: 69** (72 before). SEK's and BWF's left
  with #710's entity rules, and AEM's with the 12 Oct name sync ("Advanced
  Engineered Materials"). The renamed companies' rows (CAG, CDX, ENN, HTG,
  IRX, MDR, MKT, SOV, ST1) wait for #709's first extractor run, at 14:00 UTC
  today.
- **Dividend failures in the window: 144** (12 to look at, 122 stored from a
  later notice, 10 waiting). The five above left the list. 31 estimates filed
  16 to 24 Jun, read for the first time, joined it; 29 of them were stored
  from a later notice. LED's estimate, and MA1's and REV's (due 12 Oct), were
  stored from their updates. To look at:
  - GMG `estimated_only`, overdue since 20 Aug, new. Its notice for the half
    to 30 June (`03104557`, 16 Jun) estimates AUD 0.15, unfranked, with the
    actual due 20 Aug. GMG files one Appendix 3A.1 a half and no update: the
    crawl has one a half since 2024, and ASX's own 2026 list has no update.
    GMG has no dividend rows. Whether to store an estimate that no update
    replaces is the user's call, as with LRT's. The user chose to store it
    once GMG's own results document confirms it: fixed in the entry above.
  - LRT (four notices now, one from the backfill), GNE, SST: overdue,
    withheld as agreed.
  - RGB, RG1, LF1: `not_appendix_3a1`, nothing to do.
- Waiting, due 14 Oct to 19 Nov: QRI, DPM, DN1, KKC, TOT, RFF, DXC, DXI and
  PAF (two notices).

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

Fixed on this branch (the user said to resolve all of them):

- **Entity cleaning** (`notANameREs` in Go, `clean_entity` in Python, one
  fixture): an address with the state in full or a comma before the postcode
  ("Victoria, 3121"), and the Appendix 4E label "over which control was
  gained or lost". Of the 365 distinct entities stored on prod, these two
  rules change exactly two, SEK's and BWF's, whose results the API then
  serves; "Bank of Queensland Limited" is in the fixture so a state in a name
  stays a name.
- **Notice parser 5.** An NZ 2A.9 total with or without the Part 3F
  supplementary (AFP). A blank 1.6 security code takes the 1.3 issuer code,
  except in a notice with a Part 3D: CBAPI's notice has a Part 3A too, and a
  hybrid's distribution must not become its issuer's ordinary dividend (a
  test blanks CBAPI's code). An amount only in the estimate field is actual
  when the notice answers every "Estimated or Actual?" with "Actual": LED's
  finalisation; LRT's last update answers one of each and stays withheld. A
  text layer that runs labels, answers and values together is split back
  into lines (Storage King's, listed under ASK, stored under SKG). Part 3C
  scrip counts toward the total and is never stored: BCN stores its $0.10
  cash, and VMC, paid only in shares, records the new final outcome
  `scrip_only`, which the review does not list.
- **Checked against prod:** the 168 notices of the window's failures and 50
  parsed ones, re-read with parser 5. 154 unchanged; the 5 failures above
  change as intended (SKG 0.031 25% franked, LED 0.01625, BCN 0.10, AFP
  A$0.0201525, VMC `scrip_only`); every parsed notice gives the row parser 4
  stored (9 of them now under a later update's URL, same amounts, and MA1's
  later notice changed its amount, which stands). Parsed notices are never
  read again, so the version bump re-reads only failures.

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
