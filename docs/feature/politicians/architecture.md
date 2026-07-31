# Politician Register of Interests — architecture

> **This is the decision-and-incident record, not the current-state reference.**
> It is long because it keeps the reasoning and the wrong turns — §8.x in
> particular is the wrong-fact history, and it is the thing to read before
> changing resolution logic.
>
> For what is true *now* — sources and their licences, the schema, the pipeline
> and the runbook — start at **[README.md](README.md)**.

The influence-layer dataset that ties a named federal parliamentarian to a
listed company (item 1 shareholdings) and to a suburb (item 3 real estate).
Source: the **Register of Members' Interests** (House) and **Register of
Senators' Interests** (Senate), published as PDFs by aph.gov.au.

`ROADMAP.md` Track A / Phase 4. Editorial gate:
[`docs/influence-editorial-standards.md`](../../influence-editorial-standards.md).

> **The hard constraint.** The registers disclose *what* is held — **never
> quantity, value or price**. No share counts, no dollar figures, no returns.
> There is deliberately no `amount`/`value`/`quantity`/`units`/`shares`/`price`
> column anywhere in this subsystem, and none may be added. Enforced by
> `services/migrations/register_of_interests.test.mjs`.

---

## 1. Verified source facts

Measured against the live site during design (2026-07-25). Several contradict the
obvious guess — **do not "simplify" them away.**

### 1.1 The WAF is inverted

| Request | Result |
|---|---|
| **No `User-Agent` header at all** | **200 OK** |
| Real Chrome UA string | 200 OK |
| `shorted-data/1.0 (+https://shorted.com.au)` | **403 WAF block** |
| `Mozilla/5.0` | **403** |
| `Mozilla/5.0 (compatible; shorted-politics/1.0; +https://shorted.com.au)` | **403** |

APH allowlists specific real-browser UA tokens and 403s everything else. The
honest-identifier convention that works for ABS (`absdata.UserAgent`) **fails
here**.

**Our posture — omit `User-Agent`, self-identify out-of-band:**

```
(no User-Agent header)
From: ops@shorted.com.au
X-Crawler-Contact: https://shorted.com.au
```

Verified 200 on both listing pages and PDFs. **Do not spoof a browser UA** — that
would be WAF evasion, against the `lobbyists.go` "never bypass a block" rule.
`robots.txt` is `Allow: /` with 4 Disallow paths (events calendar, watch
parliament), none touching the register, and no `Crawl-delay`.

A 403 is therefore a **real signal** (policy change), never something to retry
around. It gets its own freshness alarm.

### 1.2 House of Representatives — structured HTML tables

Listing rows are proper table rows, one per member:

```html
<tr>
  <td class="date">9 July 2026</td>
  <td>Albanese, Hon Anthony, Member for Grayndler, NSW </td>
  <td class="format"><a href="/-/media/.../48p/AB/Albanese_48P.pdf"><img title="4948KB" ...></a></td>
</tr>
```

- **The `<a>` text is empty** — it wraps an `<img>`. Identity comes from the
  **sibling `<td>`**: `Surname, Title Given, Member for Division, STATE`.
- The `date` cell is that member's **last-updated date** → a free per-member
  freshness signal for incremental crawls. `img@title` carries the file size.
- Filenames are irregular — `Scrymgour.pdf`, `Leeser46P.pdf`, `ChesterD_48P.pdf`,
  `Dai_Le_48P.pdf`, `Llewellyn_OBrien48P.pdf`, `AbbottT_45P.pdf`.
  **Never construct PDF URLs. Always scrape.**

| Parliament | Listing path | Member PDFs | Text layer |
|---|---|---|---|
| 48th | `/Senators_and_Members/Members/Register` | 151 | TEXT (31/31 sampled) |
| 47th | `…/Previous_Parliaments/47th_Parliament_Register_of_Members_interests` | 155 | **MIXED** |
| 46th | `…/Previous_Parliaments/46P_Members_Interest_Statements` | 153 | TEXT |
| 45th | `…/Previous_Parliaments/45P_Members_Interest_Statements` | 158 | **SCAN** (35-46 ch/pg) |
| 44th | `…/Previous_Parliaments/44P_Members_Interest_Statements` | 152 | **SCAN** (0 ch/pg) |

**769 House member PDFs** (measured by a full discovery run), roughly 460 text /
310 scan.

> Counting caveat: a loose `/-/media/…\.pdf` scrape of these pages returns
> 775, because each listing also links non-member PDFs — the Explanatory Notes
> booklet and a 1984 Resolutions document — under the same `Register/` prefix.
> The discovery filter therefore requires the **parliament folder segment**
> (`/Register/<NN>p/<letters>/<file>.pdf`, case-insensitive: 48P uses `48p`,
> 47P uses `47P`). A prefix-only filter silently ingests the booklet as if it
> were a member.

Scan-vs-text must be detected **per page**: `Albanese_48P.pdf` is a 300dpi scan
(157 ch/pg) inside an otherwise all-text parliament, and 47P is genuinely mixed
(`Albanese_47P` = 7 ch/pg SCAN, `Gorman_47P`/`Pike_47P`/`van_Manen_47P` = TEXT).

### 1.3 Senate — combined tabled volumes

No per-senator PDFs. `…/Senate/Senators_Interests/Tabled_volumes` lists **89
volumes spanning 1994→2025**; hrefs `/-/media/<GUID>.ashx` (older
`~/media/<GUID>.ashx`), link text e.g. `lodged between 1 July 2025 and 19 August
2025 - Volume 1 (PDF 2MB)`.

**35 volumes fall in the 2013+ window** (measured), max 33MB. The 188-196MB
monsters are all pre-2006 and out of scope. 2022+ volumes are born-digital TEXT
(~830 ch/pg); 2016 and earlier are SCAN.

Volume labels are hand-typed and drift, so the parser tolerates: `lodged
between X and Y`, `lodged between X to Y`, `lodged by X` (open start), a
year-less first date (`between 1 July and 31 August 2014`), both `- Volume 1`
and the legacy `Volume - 1`, `(statements only)` / `(alterations only)` markers,
and at least one source typo (`27 NoveMber 2003`).

**Post-election rounds carry full statements** and are split A–L / M–Z into
Volume 1 / Volume 2: 2014, 2016, 2022, 2025. Intervening volumes are
alteration-only. So every senator serving from 2014 onward has a reachable base
statement inside our window. A senator whose base statement predates the window
gets **"first seen" semantics** (dashed unknown-start in the UI) — never a
fabricated start date.

### 1.4 Document structure — one 14-item form, both chambers

1 Shareholdings · 2 Trusts/nominee companies · 3 Real estate · 4 Directorships ·
5 Partnerships · 6 Liabilities · 7 Bonds/debentures · 8 Savings/investment
accounts · 9 Other assets · 10 Other income · 11 Gifts · 12 Sponsored travel ·
13 Office holder/donations · 14 Other interests.

**Stock link = item 1 (and 4). Suburb link = item 3.**

Every item is a table with **three holder rows** — `Self`, `Spouse/Partner`,
`Dependent Children` — and the labels **wrap across two physical lines**.

**Alterations are event-sourced deltas — verified.** `Gorman_47P.pdf` (32pp) is
1 × `Statement of Registrable Interests` followed by 10 ×
`NOTIFICATION OF ALTERATION(S) OF INTERESTS`, each with explicit `ADDITION` and
`DELETION` sections. One PDF = full history for that parliament. Senate volumes
use `Form A` / `Form A – Alteration` with a `Surname: / Other names: /
State/Territory: / Date:` header block and `Addition` / `Deletion` tables.

Item-1 cells are free-text prose blobs mixing comma **and** period separators,
ETFs with equities, and real typos:

> `ANZ, Arena REIT, Beta shares Asia ETF, BHP. CBA, Cochlear, CSL. … GWA Group
> Ltd, … ramsay Healthcare Ltd, Resmed Inc, … Betashares S7P 500 Equal Weight
> ETF, Gloabl X Morningstar Global Tech ETF, Vanguard Eth Consc Int Shares Index ET`

Item-3 locations are **suburb-or-area only** — the source contains no street
addresses: `Greenvale, VIC` · `South Gladstone, Queensland` · `Porepunkah, Vic` ·
`Island Beach (SA)` · `Prospect Vale Tas` · `Central Coast`.

---

## 2. Phase 0 findings (resolved unknowns)

### 2.1 `"company-metadata"` contains ASX ETFs — but the names are mangled

All eight probed tickers exist, with abbreviated `company_name` values that will
**not** exact-normalise-match register text:

| stock_code | company_name |
|---|---|
| `VAS` | `Vngd Aus Shares Etf Units` |
| `A200` | `Betaaustralia200etf Etf Units` |
| `IOZ` | `Ishares S&P/Asx 200. Etf Units` |
| `VGS` | `Vngd Intl Shares Etf Units` |
| `MVW` | `Vaneck Equal Weight Etf Units` |
| `CBA` | `Commonwealth Bank Of Australia.` |
| `BHP` | `Bhp Group` |

**Consequence:** ETF/LIC declarations need **curated aliases essentially
universally** — the rows exist, but no register spelling will reach them by exact
match. Budget alias curation for the ~200 common ASX ETF/LIC tickers as its own
work item, separate from the equity backlog.

Note `BHP | Bhp Group` *will* match: `normalizeEntityName` strips the `GROUP`
suffix, so `BHP GROUP` → `BHP`. But `CBA` won't — it's a ticker, not a name.
This is exactly why exact-only resolution lands at 45-60%.

### 2.2 `aph_mpid` is a stable PERSON id

Barnaby Joyce (Senate 2005-2013 → House 2013-) has a **single** MPID `e5d`, and
`…/Parliamentarian?MPID=e5d` renders both "Senator" and "Member for New England".
So MPID survives chamber changes and is a person id, not a term id.

Format is **opaque alphanumeric** — `316915`, `R36`, `e5d`, `11788`, `282981`.
Store as `TEXT`, never parse or coerce.

**Caveat:** MPID is *not* on the Register listing pages, only on
`Parliamentarian_Search_Results`. So Register → MPID is a join, and the two name
formats differ:

| Surface | Format |
|---|---|
| Register listing `<td>` | `Albanese, Hon Anthony, Member for Grayndler, NSW` |
| Parliamentarian search `<a>` | `Hon Anthony Albanese MP` |

Both need normalising to a common `person_key` before joining. Identity therefore
does **not** depend on MPID — it's populated opportunistically.

### 2.3 pymupdf word-bboxes solve the table — no pdfplumber needed

`pymupdf` is already in `services/report-extractor/requirements.txt`.
`page.get_text("words")` on a born-digital House page yields a completely regular
geometry:

```
 y= 76.34 x0= 35.5  3. Real estate, including the location (suburb or area only) and the purpose…
 y=116.66 x0=100.1  Location                Purpose for which owned      <- column header
 y=134.99 x0= 40.9  Self      Greenvale,@100  VIC@151   Residential@333
 y=168.38 x0= 40.9  Spouse/   Not@100 Applicable@118   Not@333 Applicable@350
 y=183.46 x0= 40.9  Partner                                              <- label continuation
 y=201.78 x0= 40.9  Dependent Not@100 Applicable@118   Not@333 Applicable@350
 y=216.85 x0= 40.9  Children                                             <- label continuation
```

- Item headings sit at **x0 ≈ 35.5** and match `^\d{1,2}\.`
- The column-header band sits at **x0 ≈ 100** (indented past the label column)
- Data rows sit at **x0 ≈ 40.9** and begin with a holder token
- Label continuations (`Partner`, `Children`) are bands entirely left of x≈95

### 2.4 The listing cells drift, and the drift is recoverable

A full 769-document discovery run initially left 4 rows with no division and 1
with no date. All five turned out to be source wording drift, not parser bugs,
and all are now handled with the real strings as test cases:

| Observed cell | Issue |
|---|---|
| `Hockey, The Hon Joe, Former Member for North Sydney, NSW` | `Former Member for` (members who left mid-parliament) |
| `Hastie, Mr Andrew, for Canning, WA` | `Member` missing entirely |
| `McBain, Ms Kristy , Member Eden-Monaro NSW` | no `for`, and the state is inside the same comma-part |
| `Husic, The Hon Edham` + `<td class="date">1April 2020</td>` | date lost its space separator |
| `NSW¹` `TAS³` `SA⁴` `SAC` `WAW` | footnote markers glued to the state token |

The footnote recovery tests the **full token first**, so a real three-letter
state (NSW/QLD/TAS/ACT/VIC) is never truncated; only two-letter codes (SA/WA/NT)
can be rescued by dropping a trailing letter.

Final coverage: **769/769 divisions, 769/769 dates, 767/769 states.** The two
state-less rows (`Chester … Member for Gippsland`, `Butler … Member for
Griffith,`) genuinely omit it at source.

Column x-origins are stable and **derivable from the column-header band**:
2-column items are `{100, 333}`, 3-column items `{100, 253, 406}`. Bucket each
value word into a column by x rather than concatenating.

A prototype grouper (cluster words into 3pt y-bands → a band starting with a
holder token opens a logical row → a band wholly left of x≈95 merges its label
into the preceding row) produced correct output, and exposed **three guards the
parser must have**:

1. **Segment items first.** Without an item boundary, the `dependent_children`
   row swallows the *next* item's column-header band (it's right of the label
   threshold, so it looks like a wrapped value). A band at x0≈35 matching
   `^\d{1,2}\.` closes the current item.
2. **Consume the column-header band as a header**, not as a value.
3. **Exclude footers.** The bare page number (`3` at x0≈294, y≈793) otherwise
   merges into the last row as a value.

### 2.5 A blank page is not a scanned page

Classifying "low text + has an image" as a scan marks **every** born-digital
House statement as `mixed`, because every one of them carries a full-bleed
letterhead image and 1-2 blank continuation pages holding nothing but their own
page number. Left alone that would have routed roughly **1,000 empty pages**
across the corpus to the vision tier.

The two populations separate unanimously on two signals (measured over a
12-document sample plus a known scan):

| Page kind | Image coverage | Text blocks | Chars |
|---|---|---|---|
| Blank continuation page | 0.84 (letterhead) | 1 (the page number) | 1-2 |
| True scanned page | 1.00 (full bleed) | 0 | 0-46 |

Effective DPI is **not** a usable discriminator — the letterhead is 220 DPI
while real scans measured 144, 150 and 300.

So a low-text page is a `scan` when it has a full-bleed image **or** no text
blocks at all, and `blank` otherwise. The test is an OR rather than an AND on
purpose: mislabelling a blank page as a scan wastes one cheap vision call, while
mislabelling a scan as blank silently loses a member's declared interests.
Blank pages are then excluded from the document-level text-vs-scan judgement.

After the fix, the same 12 documents classify as 11 `text` + 1 `mixed`, with
`Albanese_48P` correctly isolating its 14 scanned pages.

### 2.6 Multi-value cells must keep their line structure

The real-estate cell lists one property per line. Flattening

    Warragul
    Port Melbourne

into `"Warragul Port Melbourne"` produces a locality that matches no ABS suburb
at all, silently losing both. Same for item 1, where a member may list a dozen
funds down one cell.

The parser therefore keeps `declared_lines` alongside the joined
`declared_text`, and deliberately does **not** guess which line breaks are
wrapping and which separate two entries — that is genuinely ambiguous
(`Superannuation - Public Sector Superannuation` / `Accumulation Plan` is one
value). It preserves the evidence; the location and security resolvers try both
readings.

### 2.7 `Form A` is a running page header, not a section delimiter

Senate 2025 Volume 1: **180** bare `Form A` lines but only **55** `Surname:`
header blocks across **35 distinct senators**. `Form A` repeats on every page of
a statement.

**Consequence:** the Senate splitter must anchor sections on the `Surname:` /
`Other names:` / `State/Territory:` / `Date:` header block. Using `Form A` as the
delimiter would shatter each statement into ~5 fragments. `Form A – Alteration`
is still the reliable *kind* discriminator for the section it heads.

---

## 3. Architecture

**Go owns crawl + manifest + DB load + entity resolution. Python owns PDF → JSON.**
They meet at a content-addressed JSON artifact plus status columns on
`register_documents`.

Rationale: `services/go.mod` has no PDF library and pure-Go candidates don't
reproduce the column geometry above. `services/report-extractor/` already has
pymupdf, a threaded `genai.Client` with JSON response schemas, a paid-batch guard
(`resolve_gemini_run_budget`), GCS helpers, a Dockerfile running two jobs from one
image, and a terraform module. Storing the JSON payload means re-normalising is
free and never re-hits Gemini or APH — and normalisation rules churn far more than
the PDF→JSON step does.

Corollary: **Go never parses a PDF.** Page count and text-vs-scan classification
are a Python stage (`--stage classify`), not fetch-time.

```
aph.gov.au ──(no-UA + From:)──► influence-collector -mode register-discover
                                    │  scrape 5 House tables + Senate volumes
                                    ▼
                              register_documents   ← the crawl cursor
                                    │
                                register-fetch     stream → sha256 → private GCS
                                    ▼
              report-extractor/extract_register.py --stage classify|extract
                 Tier A  pymupdf word-bbox        (born-digital, ~460 docs)
                 Tier B  Gemini page images       (~315 scans + pre-2022 Senate)
                                    ▼
                              register_extractions  (JSONB, content-addressed, versioned)
                                    │
                                register-load     → politicians / terms / statements / declared_items
                                register-resolve  → securities + locations + interval fold
                                register-refresh  → MV + revalidate ping
                                    ▼
                    PoliticiansService ──► /politicians + 4 integration surfaces
```

### 3.1 Licensing & publication posture

Parliamentary material, © Commonwealth. **Extracted facts are publishable with
attribution; the PDFs must not be mirrored wholesale.**

- Public surfaces deep-link the `aph.gov.au` `source_url` and carry an as-at date.
- The GCS bucket is a **private working cache**: uniform bucket-level access,
  `public_access_prevention = "enforced"`, never any `allUsers` IAM, never fronted
  by a CDN, `storage_uri` never exposed on a read path, and a 400-day object
  lifecycle on `aph/**`. The JSON artifacts and DB rows are the durable asset; the
  PDFs are re-fetchable. That makes "we do not maintain a mirror" true in fact.
- Every fact table carries `source`, `source_licence`, `source_url`, `fetched_at`.

### 3.2 Entity-resolution posture

Only **exact normalised name** matches and **human-curated aliases** ever reach a
public surface. `analyst_fuzzy` is structurally prevented from being `resolved` by
a CHECK constraint, so a fuzzy match cannot leak through a read path even by
accident. Unlisted/wholesale managed funds resolve to a NULL `stock_code` and
render as declared text with no ticker link.

---

## 3.3 Identity

Two normalisations in `person_key`, each guarding a real way one member becomes
two people (and their declared history gets split in half):

1. **Only the first given name is kept.** The listing writes `Anthony` in one
   parliament and `Anthony Norman` in another.
2. **All punctuation is stripped**, so `O'Brien` / `OBrien` / `O Brien` collapse
   to one key. Two distinct members whose surnames differ only in punctuation is
   not a real scenario; the same member spelled two ways is.

Post-nominals arrive glued to the **surname** field (`Alexander OAM, Mr John`)
and must be stripped, while a genuine multi-word surname (`Van Manen`) must not
be truncated. Honorifics are inconsistent (`Hon`, `The Hon`, `Hon Dr`,
`Professor`) and are held separately from the given names.

Slugs are minted **once** and never reassigned — they reach OG images, the
sitemap and editorial cross-links, so renumbering means broken URLs. Collision
order is deterministic: plain name → state-qualified → numbered.

## 3.4 Security resolution

Four things reach a public surface, in precedence order:

1. **Curated alias** — a human decision outranks a coincidence.
2. **Inline ticker** — the member wrote the ASX code themselves
   (`iShares S&P 500 ETF (IVV)`), then validated against `"company-metadata"`.
   This is *stronger* evidence than a name match, and it is the only thing that
   resolves ETFs at all, since their `company_name` values are abbreviated past
   recognition.
3. **Exact normalised name** — one company or nothing, the `runMatch` rule.
4. Otherwise `unmatched` / `ambiguous`, neither of which is publishable.

### Landmines found in real data

- **Generic security words that are real ASX codes.** `ETF` is UBS IQ MSCI
  Australia ETF, `REIT` is VanEck International REIT, `LIC` is Lifestyle
  Communities. Every fund name *ending* in "ETF" resolved to `ETF`, showing ten
  members as holding a fund none had declared. A stopword list now blocks the
  ticker path for these; a member who genuinely holds one gets a curated alias.
- **Private entities are not unresolved listings.** A `Pty Ltd` / family trust /
  SMSF that matches nothing is `not_a_security`, not `unmatched`. 171 of a
  607-row item-1 backlog were private entities, and item 4 (directorships) is
  almost entirely them — leaving them in buries the real curation work.
- **Item 4 resolves at 0%.** Directorships are overwhelmingly private companies,
  so item 4 contributes no stock links. It is still resolved (a directorship of a
  *listed* company is genuinely interesting) but it must not sit in the headline
  denominator.

### Measured rates (192-document sample, parliaments 47-48)

| Metric | Value |
|---|---|
| Candidates | 1,175 |
| Resolvable (excl. not-a-security) | 799 |
| Resolved | 290 (**36.3%**) |
| via exact name / inline ticker / curated alias | 173 / 60 / 57 |
| Unmatched (the curation worklist) | 505 |

`register_resolution_backlog`, ordered by frequency, **is** the worklist.
Migration `000097` seeds 42 hand-authored aliases covering ticker shorthand
(`CBA`, `NAB`), everyday short names (`Westpac Bank`, `Rio`), nil-declaration
noise, and unlisted funds. Adding them moved CBA from 5 to 10 members and WBC
from 0 to 6.

## 3.5 Location resolution, and an editorial obligation

Item 3 asks for "suburb or area only", and the parser handles every observed
shape: `Greenvale, VIC` · `Auchenflower, Queensland` · `Barton ACT` ·
`Island Beach (SA)` · `Balgownie` (no state) · `Apartment (Forrest, ACT)` ·
`Australian Capital Territory, Kingston` (state first) · `Ballarat, VIC,
Investment` (the Purpose column bled into the line).

### Street addresses must be redacted, not stored

**Some members write a full street address anyway** — measured: 8 of 714 lines,
4 distinct addresses (`43 Lynjohn Drive, Bega`, `26/47 Wentworth Avenue,
Kingston`, …).

`docs/influence-editorial-standards.md` §4 puts home addresses out of scope
**full stop**. So the resolver keeps only the locality and the street portion is
never written to any column a read path can reach; a street number with no
suburb is rejected outright. `locality_raw` holds the redacted locality, and the
run logs the redaction count so it is never silent. A dedicated test asserts that
no street token survives into `locality_raw` or `locality_norm`.

We do not amplify the source over-disclosing.

### Ambiguity is recorded, never guessed

`name + state` is the strong path. Without a state, only a **nationally unique**
name resolves. A name matching more than one suburb — nationally (`no_state`) or
within one state (`ambiguous`) — resolves to nothing: guessing which of two
same-named suburbs a member owns property in is exactly the invention the
standards forbid.

Known area names (`Central Coast`, `Sunshine Coast`, `Blue Mountains`, …) resolve
to `region`. That is a **source characteristic**, since the register explicitly
asks for "suburb or area only" — so the freshness alarm keys on the `ambiguous`
bucket and never on `region`.

### Verified end to end

Run against the real corpus with a 51-suburb local fixture: **363 location rows,
75 resolved, and the redaction guard fired on 4 real street addresses.** The
stored `locality_raw` for `3 Kookaburra Court, Tura Beach` is `Tura Beach` alone,
and a query for any street token or leading number across every stored row
returns **0 leaked rows**.

Resolved suburbs read Kingston ACT (9 members), Griffith ACT (6), Barton ACT (3)
— Canberra, which is exactly what a federal register should produce.

The 20.7% resolve rate is a **fixture artefact, not a resolver limit**: the
fixture holds 51 suburbs against the real ABS set of ~15,000. A true rate needs
`house-price-collector -mode census` (an ABS GCP SAL DataPack), so the projected
rates in §1 stay projections until that runs.

## 3.6 The API

`PoliticiansService` (9 rpcs), each also mirrored onto the legacy
`ShortedStocksService` — `proto_parity_test.go` walks the registry and fails if a
domain rpc is missing there or the visibility annotations differ.

| rpc | Surface |
|---|---|
| `GetParliamentOverview` | `/politicians` hub tiles |
| `ListPoliticians` / `GetPolitician` | explorer + profile |
| `ListStockPoliticians` | card on `/shorts/{code}` |
| `ListPoliticianStocks` | most-declared (concentration) |
| `ListSuburbPoliticians` | card on `/housing/{state}/{suburb}` |
| `ListStatePoliticianHoldings` | card on `/economy/{state}` |
| `ListRegisterChanges` | change timeline |
| `ListShortInterestOverlap` | short-interest overlap |

**Committee/portfolio proximity is not implemented.** It needs committee
membership, which the register does not carry and we do not yet ingest.

### The gate is four layers, deliberately

The 2026-07 audit found the housing licence gate leaking on the one read path
that trusted its upstream, so:

1. `register_item_securities_public_gate` CHECK — a fuzzy match can never be
   `resolved` at all
2. `mv_register_public_holdings` — only identity-resolved people, only cleanly
   extracted documents
3. the store queries re-assert `stock_code IS NOT NULL` rather than trusting (2)
4. `POLITICIAN_INTERESTS_ENABLED` — a kill switch, default ON, returning an
   **empty response rather than an error** so a surface degrades instead of
   breaking

### Editorial constraints held in the API itself

- No field anywhere expresses an amount, share count, price or return.
- `declared_from_known = false` reaches the wire as a **nil** timestamp, not the
  zero time, which would serialise as 1 January year 1 and render as a real date.
- Counts are of **people**, never rows: a member declaring one company across
  three statements is one member.
- `ListShortInterestOverlap` serves its caveat **in the response body**
  (`disclosure_note`), because a member's name beside a rising short line is
  exactly the juxtaposition rule 2 governs — a consumer must not have to remember
  the disclaimer.
- Every response carries `source_licence`.

Party is not on the Register listing, so it comes from
`politician_terms.division` → `suburb_demographics.federal_division` →
`federal_party`, already populated by `-mode electorates`.

### Smoke-tested live

Against a freshly built binary (with the LISTEN pid verified — a 1-day-old stale
server was squatting the default port and would have served old code):

```
GetParliamentOverview        171 politicians, 1145 statements, 151 companies, 34 suburbs
ListStockPoliticians CBA     10 distinct people, holder labels, unknown starts
ListPoliticianStocks         TLS 14, CBA 10, NAB 9, BHP 8, WES 7, WBC 6
ListSuburbPoliticians        Kingston ACT, 9 declaring members
ListStatePoliticianHoldings  NSW, 52 members
ListShortInterestOverlap     DRO 11.94%, FLT 11.43%, TWE 10.92% + disclosure served
POLITICIAN_INTERESTS_ENABLED=false  ->  HTTP 200 {} on every rpc
```

## 4. Status

| Phase | State |
|---|---|
| 0 — verification spike | **done** (§2) |
| 1 — migration 000096 + `register-discover` | **done** — manifest holds 804 documents (769 house, 35 senate); 459 fetched (46P/47P/48P) |
| 2 — `register-fetch` + classify | **done** — streaming content-addressed sink, per-page classification |
| 3 — deterministic parser + golden set | **done** — text tier parses base statements + both alteration variants |
| — 47P centred-label layout | **known gap, quarantined** (see §2.8) |
| — item-3 multi-property rows merge | **known gap, purpose suppressed on read** (see §2.9) |
| 4 — `register-load` + identity | **done** — person/term spine, artifacts loaded to normalised rows; party seeded from the committed AEC result (see §2.10) |
| 5 — security resolution + curated aliases | **done** — 36% of resolvable item-1 candidates; alias seed + backlog view |
| 6 — location resolution → `sal_code` | **done** — verified end to end; redaction guard fired on 4 real addresses. True match rate needs the ABS census ingest |
| 7 — vision OCR tier | **built + verified** (see §7) — agy-backed, no GEMINI_API_KEY. 44P/45P fetched + classified (5,823 pages); the bulk vision run is an operator step |
| 8 — `politicians.proto` + backend API | **done** — 9 rpcs live and smoke-tested; kill switch verified |
| 9 — `/politicians` frontend + 4 integrations | **done** — 4 routes + 4 integration surfaces verified in the running app (10/10 browser checks) |
| 10 — ops wiring + launch gates | **done** — image + Cloud Run Job + monthly scheduler + `register-freshness` sentinel; launch gate corrected (see above) |
| 11 — §8.16 hidden-listing blocker | **closed** (see §8.17) — withholding quarantine + 5 further wrong-fact defects fixed; migration `000099` |

### 2.8 The 47P form centres its holder labels — quarantined, not guessed

The 47th-Parliament base form differs structurally from 46P/48P:

- the column header sits **right** of the value column (header x≈121, values
  x≈112), so deriving the label boundary from the header dropped the first word
  of every cell — `Not Applicable` became `Applicable`, `X Pty Ltd` became
  `Ltd`. Fixed by making `LABEL_X_MAX` a fixed 95 that is never raised.
- holder labels are **vertically centred** against multi-line blocks rather than
  top-aligned, so `Self` can appear *below* eight lines of its own values.
  Attributing by label order would silently mis-assign holdings between Self /
  Spouse / Dependent children.

Wrong attribution published under a named person is far worse than a known gap,
so those documents are marked `extract_status='partial'` and excluded from the
load. `pymupdf.find_tables()` **does** recover the holder structure correctly
and is the likely fix, but it truncated multi-line cell content in a first probe,
so it needs its own pass.

Of 197 classified documents: 149/150 of 48P extract cleanly (the 1 partial is
the Albanese scan), while 47P splits 32 top-aligned / 15 centred. One 48P
document (`Marles_48P`) still yields 23 fragment rows and needs the same
treatment.

The quarantine is **retroactive**: `register-load` purges statements belonging to
documents that a re-extract has downgraded, or the gate would only apply to
documents that were never loaded.

### The launch gate is a MERGE gate, not a runtime flag

> **Correction (2026-07-26).** This document previously said the feature "stays
> dark (`industry_intelligence_sources.public_enabled = FALSE`)". **That was
> false**, and the Phase 9 commit message repeated it.

`public_enabled` is read in exactly one place in the codebase —
`postgres_industry_intelligence.go:87` (`conds := []string{"s.public_enabled"}`)
— which filters `industry_intelligence_records`. **The register pipeline never
writes that table**, and `mv_register_public_holdings` does not join
`industry_intelligence_sources`. So the `FALSE` on the registry row is inert for
every politician read path. It is kept for catalogue completeness, not as a gate.

The only runtime control is `POLITICIAN_INTERESTS_ENABLED` (`politicians.go`),
which defaults **ON** and is a *takedown kill switch*, not a dark-launch flag.
That default is deliberate and matches the standing preference against opt-in
dark flags — but it means **merging this branch publishes the feature**.

Therefore the gate is enforced by a human at merge time:

1. the QA gates in §5 pass,
2. the editorial template review against `influence-editorial-standards.md`
   rules 1-8 is signed off and the outcome recorded (who / when / commit),
3. only then does the branch merge.

If a genuine runtime dark period is ever needed, `POLITICIAN_INTERESTS_ENABLED=false`
alone is **not sufficient**: the rpcs return HTTP 200 `{}`, so the routes still
render empty, the nav entry still shows, and `sitemap.ts` still advertises
`/politicians`, `/politicians/short-interest` and `/politicians/changes` — which
would get empty pages indexed. Gate the nav item and those three sitemap entries
on the same value if you take that path.

### 2.9 Item 3 merges multi-property rows — purpose suppressed on read

Item 3 is a table with **one row per property**:

```
Location                                Purpose for which owned
House Buchanan NSW                      Residential (owned jointly with spouse)
Unit Kingston ACT                       Residential (owned jointly with spouse)
House and granny flat Kurri Kurri NSW   Investment (owned jointly with spouse)
Unit Nelson Bay NSW                     Investment (owned jointly with spouse)
```

Only the FIRST row carries the `Self` label; the rest have an empty label column
and therefore read to the band grouper as wrapped continuations of the row above.
All four collapse into one declared item whose purpose is the space-joined run-on
`Residential (…) Residential (…) Investment (…) Investment (…)`, and whose
location blob yields a single resolved locality.

**Measured on the loaded corpus (2026-07-25):**

| Item-3 non-nil rows | 363 |
|---|---|
| rows merging ≥2 properties (≥2 state tokens) | **106 (29%)** |
| rows carrying a run-on purpose | **115 (32%)** |
| distinct localities captured per item | 1 (always) |

Two consequences, and they differ in severity:

1. **Purpose becomes unattributable.** Rendering that string next to the one
   resolved suburb asserts every listed purpose attaches to the property *in that
   suburb* — for Swanson above, the Kingston unit would read as both residential
   and investment. That is a misattribution about a named individual, so
   `attributableSecondaryText` (`politicians_attribution.go`) blanks a purpose
   that names two or more purposes, for item 3 only. A blank field is honest; a
   run-on is not.
2. **Property counts undercount.** A member with four properties contributes one
   locality, so `mv_register_suburb_property` is a floor, not a total. Surfaces
   say "declares real estate in X", never "owns N properties".

The raw text is **kept** in `register_declared_items` / `register_holding_periods`
for audit and for the re-parse. This is a read-path gate, not a data edit: when
the row splitter lands, these strings stop matching the run-on pattern and purpose
reappears with no change to the API.

> The fix belongs with the §2.8 47P work — both are the same band-grouping
> problem, and `pymupdf.find_tables()` is the likely answer to both. Splitting on
> the Location column starting a new logical entry is not safely inferable from
> the current y-band heuristic.

### 2.10 Party is seeded from the AEC result, and its VINTAGE is load-bearing

The register form records a member's **name, seat and state — never their party**.
`politician_terms.party` existed from migration 000096 but nothing populated it,
so every party chip rendered grey "Other" and `partyCounts` returned a single
`Other` bucket.

`seedTermParties` (`aph_party.go`, run inside `-mode register-load`) fills it from
the already-committed AEC output `web/public/geo/electorates/federal-divisions.json`
(`division → {member, party, partyAb, state, tppAlp}`). Result: **150 of 150** 48P
terms carry a party, 0 unmatched divisions.

Three things that are easy to get wrong here:

- **One file describes ONE election.** Divisions change hands, so applying the
  2025 result to the 47th Parliament would attribute the wrong party to a named
  person. Only `electoratesParliament` (48) is seeded; the 21 people whose latest
  term is 47P keep a NULL party and render no chip. A blank chip is honest.
  **Bump the constant in the same commit that refreshes the JSON.**
- **Match divisions case- and punctuation-insensitively.** The AEC's own files
  disagree with themselves (`O'connor` in the boundary file, `O'Connor` in the
  results CSV) — exact matching silently drops those seats.
- **Seed BEFORE the queue-empty return, not after the load loop.** Once the
  backlog is drained every run has an empty queue, so a post-loop seed would
  never re-apply a refreshed JSON. It runs twice: once before, once after the
  loop for terms that run created.

`postgres_politicians.go` reads `COALESCE(t.party, e.federal_party, '')`, so the
term wins and the `suburb_demographics.federal_division` join stays a fallback —
which matters because **senators have no division** and could never resolve
through it.

---

## 5. Ops

### 5.1 The image and the job

| Artifact | Path |
|---|---|
| Binary | `services/jobs/cmd/shorted` — the register modes are `shorted influence -mode register-*` (`services/jobs/internal/jobs/influence/aph_*.go`) |
| Image | `shorted-jobs`, built by the `terraform-deploy.yml` `build-images` matrix |
| Cloud Run Job + scheduler | `terraform/modules/influence-collector/` |
| Env wiring | `terraform/environments/{dev,prod}/main.tf` + `variables.tf` |

Three things that will bite:

- **The `influence` SUBCOMMAND and `-mode all` are both load-bearing.** The
  register modes now live in the consolidated `shorted <job>` binary, so every
  invocation needs `influence` first — without it the container prints usage and
  exits 2. And the job's flag default is `-mode tax`, unlike economy and
  house-prices which default to `all`, so an argless run silently ingests ATO
  corporate tax only and reports success. Terraform sets both explicitly.
- **The stealth bind-mount block is required even though this collector imports
  no stealth code.** A bare `go mod download` resolves every module
  `services/go.mod` requires, including the private `github.com/skunkworq/stealth`
  that `services/pkg/stealthhttp` needs. CI passes it as the `github_token`
  secret; local builds can bind-mount the repo instead.
- **Build context.** Measured 2026-07-26: the `services` context was **1.94GB**
  and took ~12 minutes to upload, which reads as a hung build. `services/.dockerignore`
  now excludes venvs, model weights, `data/` and `__pycache__`, taking it to
  **75MB**. That speeds every image in the matrix, not just this one. Do not pass
  `--build-context stealth=~/projects/stealth` locally unless you need it — that
  directory carries ~8.7GB of local artifacts.

### 5.2 The register modes are NOT scheduled

`-mode all` excludes `register-discover|fetch|load|resolve` by design, and the
monthly scheduler runs `-mode all`. A 804-document crawl of a parliamentary
website must never fire from a deploy step or an unattended timer.

Operator-run, in order:

```bash
# The register modes ship in the CONSOLIDATED `shorted <job>` binary, so every
# invocation needs the `influence` subcommand first. Without it the container
# prints usage and exits 2.
gcloud run jobs execute influence-collector --region australia-southeast2 \
  --args="influence,-mode,register-discover" --wait     # manifest only, no downloads
gcloud run jobs execute influence-collector --region australia-southeast2 \
  --args="influence,-mode,register-fetch,-register-limit,260" --wait
# then the extractor job: --stage classify, then --stage extract
gcloud run jobs execute influence-collector --region australia-southeast2 \
  --args="influence,-mode,register-load" --wait
gcloud run jobs execute influence-collector --region australia-southeast2 \
  --args="influence,-mode,register-resolve" --wait      # also refreshes the MVs
```

Locally, the same modes run straight off the shared binary:

```bash
cd services/jobs && go run ./cmd/shorted influence -mode register-resolve
```

**The register tests are gated by `run-tests` in `terraform-deploy.yml`.** They had
to be re-gated after the port: `services/jobs` is a SEPARATE Go module, invisible
to `go list ./...` in `services`, and nothing in CI ran it — so moving the suite
into that module silently took every §8.17-§8.19 wrong-fact regression out of CI.
A step now runs `GOWORK=off go test ./...` in `services/jobs`, which also gates
economy, marketdata, news and reportextract for the first time.

**A bare mode name is rejected.** `shorted influence register-fetch` — the runbook
typo of dropping `-mode` — used to parse clean, leave the mode at its `tax`
default and fall into the `case "tax"` arm, ingesting the whole ATO corporate-tax
corpus instead of draining the fetch queue. `fs.NArg() > 0` now errors, matching
discovery/house-prices/news.

**`ELECTORATES_DIR` must be set or the party seed silently skips.** The default is
repo-relative (`../../web/public/geo/electorates`) and resolves only when the
binary runs from `services/jobs`; it does not exist inside the distroless image at
all, and the JSON lives outside that image's build context (`services`), so it
cannot simply be COPYed in. Consequences, in order:

- `register-load` warns LOUDLY and continues — a missing party is a coverage gap,
  not a wrong fact, so failing the run would be worse.
- House members still get a party: `postgres_politicians.go` reads
  `COALESCE(t.party, e.federal_party, '')` and the
  `suburb_demographics.federal_division` join covers them.
- **Senators get nothing**, because they have no division. Not yet biting, since
  the 35 Senate volumes are unfetched.

Until the file is mounted or embedded, run `register-load` with
`ELECTORATES_DIR=<repo>/web/public/geo/electorates` — verified to seed 152 of 152
48P terms. Embedding it would duplicate a committed data file whose VINTAGE is
load-bearing (§2.10), so it is deliberately not duplicated.

`REGISTER_DRY_RUN` defaults **true** and is pinned true in the job definition —
every one of those is a no-op until it is explicitly set false. The fetch queue is
ordered `parliament DESC`, so `-register-limit N` always covers the newest
parliament first and a cap lands on a parliament boundary rather than at random.

`register-fetch` **aborts the entire run on a single 403** rather than working
through a WAF policy change.

### 5.3 The freshness sentinel

`-mode register-freshness` (read-only, exits non-zero on an alarm) run weekly by
`.github/workflows/register-freshness.yml`. Same contract as economy-freshness:
alarm → workflow fails → GitHub notifies.

| Check | Alarms when | Why it is otherwise silent |
|---|---|---|
| `aph-waf` | any document has `http_status = 403` | APH revoking the no-UA posture makes every fetch fail while nothing else looks wrong — the corpus just stops growing |
| `aph-staleness` | newest fetch > 28 days | the crawl stopped, for any reason |
| `aph-extract-backlog` | text documents fetched but unparsed > 14 days | unparsed documents render as a member simply having fewer entries |

Scanned documents are **excluded** from the backlog alarm — they wait on the
vision tier by design, and alarming on them would keep the check permanently red
and train the operator to ignore it. Per-parliament coverage is reported as INFO
and never fails the run.

**On an `aph-waf` alarm, do not send a browser User-Agent.** That is WAF evasion.
Re-probe the no-UA posture by hand; if it is genuinely revoked, stop crawling and
contact the publisher. The alarm text says so at the point of failure.

### 5.4 Known gap: the CI prod-deploy bootstrap still runs `go run`

`terraform-deploy.yml` (~line 1056) runs `go run ./influence-collector -mode all`
(or `-mode public-records`) inside the **prod migration step**, as a corporate-tax
bootstrap. With a real Cloud Run Job and a monthly scheduler now in place that
path is redundant, and the `else` branch re-runs `-mode public-records` on every
prod deploy.

It is **deliberately left in place**: removing it changes prod deploy behaviour
and, if the monthly job were ever failing, would silently drop a refresh that
happens today on every deploy. Retire it in its own change, with the monthly job
observed green first.

---

## 6. Launch gate

The gate is a **merge** gate enforced by a human (§ "The launch gate is a MERGE
gate, not a runtime flag"). Merging this branch publishes the feature.

### 6.1 QA gates — measured 2026-07-26

| Gate | Threshold | Measured (2026-07-27, post-§8.17) | |
|---|---|---|---|
| item-1 security resolution | ≥ 35% of `entity_kind='listed'` candidates | **51.18%** (1,174 / 2,294, measured 2026-07-31) — but see §8.19.1: the denominator is a DEFAULT bucket, so this measures explanation rather than resolution. Report the number with its band and method, never "the gate is met". §8.21 gives the backlog a screen, which is the only honest way it moves | **contested** |
| identity resolution | 0 unresolved statements | **0** of 2,757 | pass |
| 46P/47P centred-label layout | quarantined, never published | 102 docs at `partial` | pass |
| item-3 multi-property merge | purpose suppressed on read | suppressed (29% of rows merge) | pass |
| no amount/value column | none anywhere in the subsystem | enforced by migration test | pass |
| `analyst_fuzzy` publishable | never | CHECK-enforced, asserted by test | pass |
| freshness sentinel | exit 0 | exit 0 locally; alarm path mutation-tested | pass |
| scan corpus | stated as unread, never as "no declarations" | `CoverageNote` on every profile | pass |
| vehicle chip denying a listing (§8.17) | 0 | **0** of 18,900 | pass |
| `entity_kind` fabricated outside items 1 & 4 (§8.17) | 0 | **0** (was 666) | pass |
| amendment notice published as a holding, items 1/3/4 (§8.17) | 0 | **0** (was 42) | pass |
| holder label or person name published as an entity (§8.17) | 0 | **0** (was 13) | pass |
| private company carrying a live ticker link (§8.17) | 0 | **0** (was 1) | pass |

The resolution gate is the ONE that fails, and it has now failed at 24.7%, 25.2%,
25.3% and 25.2% across four attempts to move it by classification. It is not a
classification problem — see §8.17 and §8.13.

**The scan corpus is the one to argue about.** The 44th and 45th Parliaments
(310 documents) and all 35 Senate volumes are unfetched and unextracted. Without
`CoverageNote` a profile for a member who served then renders an empty list,
which reads as "declared nothing" — an absence claim about a named individual.
That is why the coverage fields are served on `GetPolitician` and stated *above*
the lists rather than as a footnote.

### 6.2 Editorial template review — rules 1-8

Seven rendering surfaces: the four `/politicians` routes, the stock rail card, the
suburb property card, the economy state card. Plus OG images, `<title>`,
descriptions, JSON-LD and alt text. `editorial-copy.test.ts` pins the count at
**9 files / 7 rendering surfaces** — a pinned count, not a floor, so a new surface
cannot be added without failing the test and re-triggering this review.

| Rule | Mechanism | State |
|---|---|---|
| 1 — citation + as-at on every figure | **test**: every rendering surface must contain `<SourceLine` or `<ReportErrorLink`. Caught `state-politician-holdings.tsx`, which shipped with neither. Since §8.20 every ROW also links its own document — the page-level link previously cited the wrong PDF for every row but the first | enforced |
| 2 — juxtaposition, not accusation | **human judgement**. No test can decide this. What exists: no headline pairs a member with a market metric as cause; `/short-interest` renders `disclosure_note` adjacent to the table; no warning-coloured iconography near a person; `register-items.test.ts` bans warning glyphs (⚠️🚨🔴🚩👀) and currency glyphs from the item tags | **needs sign-off** |
| 3 — banned verbs | **test**: `BANNED_VERBS` over prose in all 9 files | enforced |
| 4 — integrity bodies | no NACC/ICAC data ingested | N/A |
| 5 — what is held, never how much | **test**: `BANNED_MAGNITUDE`, plus no `$`-and-digit and no currency formatter in politician copy. No amount column exists in the schema (migration test) and the proto carries no amount field. Item 10 is tagged `📥` not a money bag for this reason | enforced |
| 6 — right of reply | N/A for automated data cards; a standing precondition for any newsroom piece built on this data | N/A |
| 7 — corrections policy | `/disclaimer#corrections` written and linked from `CaveatNote` | closed |
| 8 — report an error | **test**, same assertion as rule 1. Row-level takedown still does not exist — see §6.3 | enforced |

**What changed since the review was first drafted, and therefore needs re-reading:**

1. `DeclaredEntity` no longer says "not matched to an ASX listing" outside items 1
   and 4 (§8.17). Previously 666 published rows and 3,174 changes-feed rows made a
   match claim about superannuation accounts, trusts and gifts.
2. `HolderBadge` has new copy — **"Holder not stated"** — on 2,279 rows that
   previously rendered no chip at all beside rows chipped "Self" (§8.17).
3. `RegisterItemTag` adds an emoji + short label per form item (§8.20). Rule 2
   governs iconography; the glyph set is test-constrained but the CHOICE of glyph
   is a judgement.
4. Every row now carries a per-row source link (§8.20).
5. Rows are withheld rather than mislabelled in three new cases: multi-entity cells
   (§8.17), amendment notices, and no-signal item-1 cells (§8.19). Withholding a
   real declaration is a coverage decision a reviewer should agree with.

**Added 2026-07-31, and therefore also unreviewed:**

6. **An operator console** (§8.21) at `/admin/register/securities`. It is not a
   published surface, but it renders declared text beside named
   parliamentarians, so `editorial-copy.test.ts` now covers it: the pinned count
   moved **9 → 11 files**, `RENDERING_SURFACES` stays **7**. It is exempt from
   rules 1 and 8 (cite a source / offer a dispute path) because those are
   promises to a READER — the reviewer *is* the dispute path — but every
   candidate card links the APH PDF per declaration anyway. It passes rules 2, 3
   and 5 under test: no warning or currency glyph, no banned verb, no `$`.
7. **Withholding became reversible.** A reviewer can now classify a candidate
   `not_a_security` / `unlisted_fund` / `foreign`, which REMOVES rows from
   publication. That is a coverage decision a reviewer should agree with, in the
   same way §6.2's item 5 flagged the withholding quarantine.

#### Sign-off

The gate in §6 is a MERGE gate enforced by a human. It was **not** recorded before
PR #364 merged; this block exists so it can be. Rules 3, 5, 7 and 8 are
test-enforced and need no signature. **Rule 2 and the seven items above need a
person.**

This block is deliberately still blank. An assistant re-running the tests is not
a sign-off: rule 2 is "no test can decide this" by its own definition, and the
whole point of a human merge gate is that the human is not the author.

```
Reviewed by:
Date:
Commit reviewed:
Rule 2 (juxtaposition/iconography):   pass / fail / notes
Items 1-7 above:                      pass / fail / notes
Outcome:
```

### 6.3 Open items, stated rather than hidden

1. ~~**Row-level takedown does not exist.**~~ **CLOSED 2026-07-31.** Migration
   `000101` adds `register_declared_items.suppressed_at` (+ `suppressed_by`,
   `suppression_note`) and `selectHoldingEventsQuery` filters it in **all three**
   fold arms, so a suppressed row leaves `mv_register_public_holdings` and every
   read path below it. The row is retained with its provenance — suppression is
   never a delete, because deleting removes a real declaration from a named
   person's record and breaks the nil-rate tripwire. `aph_suppression_test.go`
   asserts the arm count, since a filter that reaches two arms of three is worse
   than none: the operator is told the row is withdrawn and it is still
   published.
   **Still missing:** there is no UI for it. A takedown today is a hand-written
   `UPDATE` followed by `register-load` + `register-resolve`.
2. ~~**The sitemap and nav are not gated by the kill switch.**~~ **CLOSED
   2026-07-31.** `sitemap.ts` now emits the three hub URLs only when the register
   actually returns politicians, and the nav entry is filtered on
   `NEXT_PUBLIC_POLITICIAN_INTERESTS_ENABLED` (default ON, matching
   `registerEnabled()` exactly). The sitemap gate is deliberately on the DATA,
   not a second copy of the env var: one switch with two places to flip is a
   switch that gets half-flipped. An API **outage** keeps the hubs — a failed
   call is not evidence of a takedown, and the sitemap must not shrink because
   the API blipped.
3. **The review outcome must be recorded** (who / when / commit). The gate says
   "signed off"; nothing here records a signature. **Still open — see §6.2.**
---

## 7. The vision tier runs on `agy`, not the Gemini API

`--stage vision` shells out to the local **`agy` CLI**, which fronts the same
Gemini models but authenticates as the operator. Consequences, all deliberate:

- **No `GEMINI_API_KEY` and no per-token billing.** The earlier plan's ~$31/pass
  estimate does not apply.
- **It is an operator-machine stage.** The report-extractor container is
  python-slim with no `agy` binary, so this cannot run in Cloud Run.
  `require_agy()` fails fast (exit 2) rather than marking a batch as failed
  extractions.
- **`--sandbox` is mandatory; `--dangerously-skip-permissions` is forbidden.**
  The latter disables agy's own approval gate. It is blocked by this
  environment's safety classifier, and `test_register_vision.py` asserts the
  string "dangerously" never appears in the argv — so nobody "fixes" a
  permission prompt by reaching for it.

### 7.1 Measured behaviour

| | |
|---|---|
| model | `gemini-3.6-flash-low` (14s/page alone; 3.5-flash-low was 23s) |
| raster | pymupdf `get_pixmap(dpi=150)` → ~1148×1755 |
| batching | **4 pages/call = 7.8s/page** vs 12.9s/page one-at-a-time — ~10-16s of each call is fixed CLI startup, so batching is the throughput lever |
| concurrency | 4-way 0.204 job/s, 8-way 0.229, **16-way 0.145 — a regression**. Default 4, clamped at 8 |
| accuracy | Gosling_48P (6pp, **0 chars/page**) transcribed 100% correctly against the page image, including that item 2 has two sub-tables (2.i + 2.ii) = 6 rows |
| end-to-end | Albanese_47P (47pp scan) → 14 items, 79 declared rows, 100% coverage |

`--print-timeout` bounds only the response wait, **not wall clock** (a 1s value
still burned 13.9s). The `subprocess.run(timeout=…)` is the real bound.

### 7.2 Landmines found by building it

- **`fitz.open(None)` returns a NEW EMPTY DOCUMENT instead of raising.**
  `open_document` returns `temp_path=None` for a `file://` URI, so passing it
  through produced zero pages, zero coverage and a silently 'partial' document —
  arriving by a route the coverage gate could not distinguish from a genuinely
  unreadable scan. `rasterise` now rejects a falsy path and a zero-page document
  explicitly.
- **The amount gate was miscalibrated.** `contains_amount` is a hallucination
  tripwire for holdings, but items **11 (gifts)** and **12 (sponsored travel)**
  legitimately carry values — the form asks for them. Measured on Aly_47P: 2 of
  25 rows carried an amount, both genuine ("total value $500", "valued at $370 ex
  GST"), which tripped the gate at 8% and quarantined a correct document. Scoring
  now excludes those two items; an amount in item 1 or 3 still trips.
  `CaveatNote` was corrected to match: holdings carry no value, gifts and
  sponsored travel do, and a figure there is a gift's declared value — never the
  size of a holding.
- **`contains_amount` is computed from OUR transcription**, by regex, never asked
  of the model. A model-supplied boolean would be an opinion where a measurement
  is needed.
- **One base statement per scanned document, by design.** The tier does not split
  a scan into base + alterations: a mis-split would attribute an ADDITION to the
  wrong period. An unsplit document reads as one declaration with an unknown
  start, which is the honest reading when the section boundaries are not visible.
- A batch that fails twice **falls back to single pages** — a batch usually fails
  because one page in it is pathological. Observed live: `agy returned empty
  stdout` and `agy exit 1`, both recovered, coverage still 100%.
- JSON is **brace-matched forward from the first `{`**, string-aware. Scanning
  backwards from the last `{` returns the innermost object — for
  `{"rows":[{"item_no":1}]}` that is `{"item_no":1}`, which parses cleanly and is
  the wrong answer.

### 7.3 Runbook

```bash
cd services/report-extractor
# 1. classify (already run for 44P/45P: 245 scan, 65 mixed, 5,823 pages)
DATABASE_URL=... .venv/bin/python extract_register.py --stage classify
# 2. vision, one parliament at a time so a bad batch is contained
DATABASE_URL=... .venv/bin/python extract_register.py \
    --stage vision --parliament 45 --concurrency 4 --batch-pages 4
# 3. load + resolve (in that order — resolve rebuilds the fold and the MVs)
cd ../ && DATABASE_URL=... REGISTER_DRY_RUN=false ./ic -mode register-load
DATABASE_URL=... REGISTER_DRY_RUN=false ./ic -mode register-resolve
```

### 7.3.1 THE BINDING CONSTRAINT IS THE agy SUBSCRIPTION QUOTA

Throughput is not the limit. Measured 2026-07-26 on a real bulk run at
concurrency 6: the quota was **exhausted after 16 documents (~200 pages, ~12
minutes)**, then produced 266 identical failures:

```
agy exit 1: Error: Individual quota reached. Please upgrade your subscription
to increase your limits. Resets in 1h7m26s.
```

So the ~2-4h wall-clock estimate is irrelevant — the corpus must be drained in
**quota windows**, roughly 16 documents (~200 pages) per window with a ~1h reset.
At that rate the remaining ~350 scan/mixed documents need on the order of **20+
windows**, i.e. days of elapsed time on the current subscription. Options, in the
operator's hands: run it as a background trickle across days, raise the agy
subscription limit, or fall back to a paid Gemini API key for a one-off bulk pass
(the original ~\$31/pass estimate).

Two code guards came out of that run, and both matter:

- **Quota is TERMINAL for the run** (`VisionQuotaExhausted`). It is never retried
  and never salvaged page-by-page; the stage aborts the queue. Same posture as the
  APH 403 — do not hammer on through a block. Without this, one exhausted quota
  marched through the entire queue marking real documents as 0%-coverage partials.
- **An empty read RAISES instead of persisting an empty artifact.** The resume
  guard is `NOT EXISTS (… tier='vision')`, so a persisted 0-item artifact would
  make the document **permanently skipped** while sitting at 0% coverage looking
  like an unreadable scan. Ten documents were poisoned this way before the fix and
  had to be deleted by hand. A failed document now writes no artifact, so a
  re-run picks it up with no `--force`.

Progress after the aborted run: **10 vision artifacts** (9 at 14 items / 100%
coverage, 1 quarantined at 61%).

### 7.4 Coverage is a SHARE, not "any"

A parliament is reported as read only when **≥95%** of its documents carry an
`extracted` artifact (`fullyReadPct`, postgres_politicians.go). Anything between
is `partial_parliaments` and says so on the profile.

An earlier version used `extracted > 0`, which claimed the 47th was covered when
87 of 155 documents had parsed — so the ~44% of members whose own document failed
rendered an empty list under a heading asserting we had looked. That is the exact
false-absence claim `CoverageNote` exists to prevent. Three states now:

| | 2026-07-26 |
|---|---|
| read in full (≥95%) | 48th |
| read in part | 46th (65%), 47th (56%) |
| documents exist, none read | 44th, 45th |

---

## 8. DeepSeek cannot do this, and local OCR is close but not there yet

### 8.1 The DeepSeek API has no vision input

Checked against the official docs, not assumed:

- `messages.content` is a **plain string**; the only models are `deepseek-v4-flash`
  and `deepseek-v4-pro`, and `GET /models` lists just those two.
- Stated explicitly: *"Array types like `image`, `document`, and `search_result`
  are **not supported**."*
- **DeepSeek-OCR** is a real vision-language model built for exactly this job, but
  it ships as HuggingFace weights — self-hosted, GPU required, not API-served.

So no DeepSeek token unblocks the OCR step. Where DeepSeek *would* fit is the
SECOND half of a split pipeline: local OCR does image → text, and its cheap text
API turns that text into structured JSON.

### 8.2 Local Tesseract is fast, free and accurate on VALUES

Tesseract 5.5.1 is already installed and MuPDF drives it (`get_textpage_ocr`).
Measured on Gosling_48P — a **0-chars/page** scan:

| | `agy` / Gemini | Local Tesseract |
|---|---|---|
| speed | 14s/page | **0.8s/page** |
| cost | quota-capped ~16 docs/hour | **free, unlimited** |
| hallucination surface | real (5 gates guard it) | **none — deterministic** |
| typed values | 100% | **7/7 ground-truth phrases**, "Not Applicable" ×7 exactly |

DPI matters: 150 over-reported "Not Applicable" (8 vs a true 7); **200 and 400
matched truth exactly**, so `OCR_DPI_DEFAULT = 200`.

### 8.3 What is wired, and the one thing still blocking it

Wired and tested (`parse_house_document(doc, ocr=True)`):

- `page_bands(page, textpage=…)` accepts an OCR TextPage. This is load-bearing:
  `get_textpage_ocr()` returns a SEPARATE object and does **not** replace the
  page's default text layer, so a bare `page.get_text("words")` on a scan returns
  **0 words** and the parser silently finds nothing. The kwarg is passed only when
  a textpage exists, so the born-digital path and its test doubles are untouched.
- A page MuPDF cannot OCR is warned (`ocr_failed:page_N`) and left unattributed,
  which lowers page coverage and quarantines the document.

**BLOCKER — do not publish OCR output yet.** With strict header matching a scan
yields **6 of 14 items** and welds items 9-11 onto item 8, so "MP Salary" (item 10
income) and "QANTAS Chairmans Lounge" (item 11 gifts) are attributed to item 8
(savings accounts). Wrong facts about a named person.

The cause is §"NOT YET OCR-TOLERANT" in `register_parse.py`: `column_origins()`
derives the value-column x-origins from the header band, and headers are exactly
what Tesseract garbles. A fuzzy variant was tried and **reverted** — it rejects
every data-row word correctly ("applicable" 0.40, "not" 0.44) but also matches
real born-digital header words ("subsidiary" against "beneficiary"), adding
spurious column origins and changing the born-digital parse. The golden set caught
it.

### 8.4 Fuzzy headers were scoped to OCR — and did NOT fix it

Fuzzy header matching is now threaded as an explicit `fuzzy` flag through
`column_origins`/`is_column_header` → `parse_item_tables`/`parse_alteration_page`
→ `parse_house_document(ocr=…)`, so the born-digital path is byte-identical (58
tests, golden set green) and fuzz only ever applies to a scan.

**It made no difference: still 6 of 14 items.** The blocker was misdiagnosed; it is
not column headers, it is ITEM HEADINGS. Measured on Gosling_48P page 2, where
items 1-3 live, Tesseract renders the three headings as:

```
'4,'     <- item "1." : digit 1 read as 4, period read as comma
'2.'     <- number kept, but the label text landed on a separate OCR line
'3.'     <- same
```

Two distinct failures, and the first is the serious one:

1. **A misread item NUMBER files a declaration under the wrong item** — item 1
   shareholdings arriving as item 4 directorships. That is a wrong fact about a
   named person, not a recall gap, and no amount of header tolerance fixes it.
2. `ITEM_HEADING_RE` needs both a number and a ≥10-char label to validate against
   the canonical 14. OCR splits number from label across lines, so validation
   fails and the rows weld onto the previous item.

Fixing this properly needs heading/label reassembly across OCR lines plus
digit-confusion handling (1/4/7, 5/S, 0/O) validated against the canonical labels
— materially more than the header work, and it must be validated against the LLM's
verified 14/14 before anything publishes.

### 8.5 The safety gate is in place regardless

`ocr_parse_gates()` (register_vision.py) is MANDATORY before any OCR'd document is
marked `extracted`:

| gate | fires when |
|---|---|
| `ocr_item_recall_low` | a base statement surfaces < 8 of 14 items |
| `ocr_core_items_missing` | item 1 (shareholdings) or item 3 (real estate) is absent — the two items this dataset exists to read |

This exists because the deterministic path's ONLY numeric gate is page coverage,
and coverage was **100%** for the 6-of-14 parse that misfiled items 9-11. Coverage
alone would have shipped it as good.

No stage runs `ocr=True` today, so nothing can publish an OCR parse — the
capability is wired and gated, not enabled. Scans stay on the quota-limited `agy`
tier, and `CoverageNote` keeps reporting 44P/45P as unread.

### 8.6 Apple Vision replaces Tesseract as the OCR backend

`register_ocr.py`, backend `vision`. On-device, free, unquota'd, and it fixes the
failure Tesseract could not: **item numbers**.

Same page (Gosling_48P p2), same parser:

```
Tesseract      '4,'  <- item "1." : digit read as 4, period as comma
               '2.'  <- number kept, label lost to another line
Apple Vision   '1. List shereholdings in public and private companies (...'  conf 1.00
               '2. List family and business trusts and nominee companies:'  conf 1.00
```

Whole-document result, deterministic parser, no LLM:

| | Tesseract | Apple Vision |
|---|---|---|
| items found | 6/14 | **12/14** |
| item 1 / item 3 | missing | **both correct** |
| item 10 income | misfiled under item 8 | **correct** |
| `ocr_parse_gates` | FAIL | **PASS** |
| wall clock | 2.9s | 3.9s |

Mechanics worth knowing:

- Vision boxes are **normalised 0..1 with a BOTTOM-left origin** — the opposite
  vertical convention to PDF text extraction. `vision_words()` flips it once.
- Vision returns roughly **one observation per table cell** on this form, so the
  x0 of each observation is an exact column origin. Words within an observation
  get x-extents apportioned by character offset, which is an approximation the
  parser tolerates because it needs a stable y per line and the x0 of each
  column's first word — both exact.
- `page_bands(page, ..., words=…)` lets a backend inject positioned text and skip
  MuPDF entirely. The born-digital path still calls `get_text("words")` with no
  extra arguments, so it and its test doubles are untouched.
- macOS + `pyobjc-framework-{Vision,Quartz}` only. Another operator-machine
  backend; the Linux container cannot run it.

**Still not publishable — two residual defects, both column-level rather than
attribution-level:**

1. **Item 8 declared/secondary are misaligned**: `declared_text` came back as
   `'NAB'` (the institution column) where truth is `'Savings'`. A semantic swap,
   not a wrong person.
2. **Boilerplate bleed**: item 11 captured the form's explanatory note
   ("children from family members or personal friends in a purely personal
   capacity need not be…") instead of the QANTAS gift value. That would render as
   a garbage declaration on a named member's profile.

Value recall is 5/6 on the probe document. Next work is boilerplate filtering
(the notes are distinguishable — smaller type, full-width, no holder label) and
item-8 column alignment. `ocr_parse_gates` PASSES on this document, so those two
must be fixed before any OCR stage is wired — the gate would not catch them.

### 8.7 The direct Gemini API is the backend to use (`--vision-backend gemini-api`)

Measured on the same probe document (Gosling_48P, 0 chars/page) and then on real
45P batches:

| backend | items | value recall | s/page | ceiling |
|---|---|---|---|---|
| Tesseract | 6/14 | — | 0.8 | misreads item NUMBERS |
| Apple Vision | 12/14 | 5/6 | 0.65 | item-8 column, boilerplate bleed |
| `agy` CLI | 14/14 | 6/6 | 14.0 | **quota ~16 docs/hour** |
| **Gemini API** | **14/14** | **6/6** | **1.6** | none hit |

It also fixed the two things Apple Vision got wrong: item 8 returns `Savings` (not
the institution column `NAB`) and item 11 returns the actual gift value rather than
the form's explanatory note.

**Batch evaluation, 45P, `gemini-3.1-flash-lite`, 4-page batches, concurrency 6:**

- 18 documents, **17 at 14/14 items and 100% page coverage**, 610 declared rows
- 1 quarantined (`vision_amount_spike` — a genuine gifts/travel value, see §7.2)
- 0 failures after the shape fix below
- ~10s per document end to end

#### Token minimisation — measured, not guessed

- **DPI is FREE.** Input tokens were flat at **6,633** for a 6-page batch across
  72 / 96 / 110 / 150 dpi — Gemini normalises images to a fixed per-image cost. So
  the lever is FEWER images, never smaller ones. `GEMINI_API_DPI = 72` because the
  payload uploads faster and 14/14 still holds.
- **A compact wire schema cut output 55%**: 1-char keys plus a nil marker took
  output from **2,027 → 906** tokens with identical accuracy (14/14, 6/6), and
  halved latency because there is less to generate. The form is overwhelmingly
  "Not Applicable", so repeating that string was most of the output bill. Nil rows
  are still EMITTED — marked, never dropped — because a nil row is what proves the
  tier read the item.
- Net: **~1,119 input + ~151 output tokens per page**. For the ~5,800 remaining
  scan pages that is ~6.5M in / ~0.9M out, on the order of **$1-2** at flash-lite
  rates — against the ~$31/pass the original plan budgeted.

#### `responseMimeType: application/json` does NOT pin the top-level shape

Three shapes came back from real batches, and the third failed 2 of 12 documents
outright with `Extra data: line 2 column 1`:

```
{"r":[...]}                 the requested shape
[...]                       a bare array
{"r":[...]}\n{"r":[...]}     ONE OBJECT PER PAGE, concatenated
```

`_collect_rows()` decodes every top-level value with `raw_decode` in a loop and
merges them. Both previously-failed documents then extracted at 14/14. Setting a
response MIME type is not a schema guarantee — do not treat it as one.

#### Key handling

`GEMINI_API_KEY` is read from the environment only. It belongs in GCP Secret
Manager injected into the job, exactly like `DATABASE_URL` in
`terraform/modules/influence-collector/` — never in a repo file, and never on a
command line that gets logged.

### 8.8 Drain progress and the environment blocker

**143 of 345 scan/mixed documents drained** via `--vision-backend gemini-api`
before the run stopped, with **0 genuine extraction failures** and 12 documents
quarantined by the gates (mostly `vision_amount_spike` on real gifts/travel
values). Every extracted document reported 13-14 items at 100% page coverage.

The run did NOT stop for a pipeline reason. The local postgres container died
under it:

```
FAILED: server closed the connection unexpectedly
psycopg2.InterfaceError: connection already closed   <- in mark_extract_failed
```

Two fixes, because a multi-hour drain must survive a DB blip:

- `run_vision` reconnects per document when `conn.closed` is set. Cheap against a
  local pool, and the queue is long enough that losing it to a dropped socket is
  the expensive outcome.
- `mark_extract_failed` now tolerates a dead connection instead of raising. It is
  the ERROR path: raising there turned one document's failure into the loss of
  every document after it, which is precisely what happened at document 143.

**The real blocker is OrbStack, not the pipeline.** The Docker daemon died twice in
one session, taking `shorted_db` with it. Disk is not the cause (249 GB free on /,
574 GB on the external volume). Nothing is lost when it happens — the 769 fetched
PDFs are on disk and the DB is on the named volume `sql_my_db_data`, which survived
the first crash intact (19,029 declared items verified after restart).

Resuming is one command; completed documents are skipped by the `NOT EXISTS`
artifact guard, no `--force` needed:

```bash
cd analysis/sql && docker compose up -d postgres     # after `orb start`
cd services/report-extractor
GEMINI_API_KEY=... DATABASE_URL=... .venv/bin/python extract_register.py \
    --stage vision --vision-backend gemini-api --concurrency 6 --batch-pages 4
# then, in this order:
#   ic -mode register-load     (party seed + normalised rows)
#   ic -mode register-resolve  (securities, locations, fold, MV refresh)
```

Sizing note for the estimate: 44P/45P average **18.8 pages** per document (max 68),
not the 6 pages of the probe document, so the corpus is ~6,500 pages and the drain
is ~2.5-3 hours at 1.6s/page — matching the original estimate rather than the
optimistic one extrapolated from small documents.

### 8.9 Full scan corpus drained — and the resolution gate now FAILS

The vision drain finished: **183 extracted, 17 quarantined, 0 failed, 6,815
declared rows** from the scan corpus. Coverage is now:

| parliament | documents | read |
|---|---|---|
| 48th | 151 | **100%** |
| 47th | 155 | 67% |
| 46th | 153 | 76% |
| 45th | 158 | **100%** |
| 44th | 152 | **100%** |

44P and 45P — the pure-scan parliaments that no deterministic tier could touch —
are fully read. 46P/47P sit at 67-76% because of the §2.8 centred-label
quarantine, which is a text-tier gap, not a vision one.

Totals after load + resolve: **324 politicians, 2,755 statements, 21,153 declared
rows, 0 unresolved identities, 18,993 holding intervals.** Most-declared:
TLS 38 members, BHP 25, NAB 24, CBA 23, WBC 19.

**The item-1 security resolution gate FAILS: 20.3%, against a documented ≥35%.**
It was 35.3% on the 48P-heavy corpus. Do NOT read this as the vision tier
extracting badly — the top unmatched candidates say otherwise:

```
GIFT            15
IAG             15
2017            13
FLIGHT UPGRADE  13
MEMBERSHIP      13
```

Only `IAG` (Insurance Australia Group) is a security. `GIFT`, `2017`,
`FLIGHT UPGRADE`, `MEMBERSHIP` are items 11/12 content — gifts and sponsored
travel — being fed through the security splitter and counted in the denominator.
44P/45P carry far more gift/travel text than 48P, so widening the corpus diluted
the rate with non-securities rather than with failures.

**Fix, in order of value:**

1. Extend the `not_a_security` vocabulary in `aph_resolve.go` with the gift/travel
   noise above. Those rows are *correctly* unresolvable and belong outside the
   denominator — `resolvable = candidates - not_a_security` already exists for
   exactly this reason.
2. Re-measure the gate afterwards. The honest threshold may also need
   recalibrating: 35% was set against a corpus that was almost entirely 48P.
3. `IAG` should resolve via `ticker_in_text` and does not — worth one look at why
   a bare three-letter ticker missed.

Until (1) and (2) land, **the launch gate in §6.1 is not met**. That is a
publishing blocker by design, and `CoverageNote` continues to report per-parliament
coverage honestly regardless.

### 8.10 CORRECTION: the resolution drop is NOT gift/travel dilution

§8.9 claimed the 35.3% -> 20.3% drop was items 11/12 gift and travel text padding
the denominator. **That was wrong**, and the fix built on it barely moved the
number: adding a `not_a_security_term` vocabulary (gifts, memberships, flight
upgrades, bare years) reclassified only **132** rows and took the gate from
**20.3% to 20.8%**. The vocabulary is still correct and worth keeping — those rows
genuinely are not securities — but it is not the explanation.

The real composition, by item:

| item | unmatched |
|---|---|
| 1 — shareholdings | **3,399** |
| 4 — directorships | 424 |

So the unmatched pool is overwhelmingly item 1 — the gate's own metric — and the
top unmatched item-1 candidates are **real securities**:

```
IAG       14      <- Insurance Australia Group, a listed ticker
Shares    10      <- genuine noise
QBE        9      <- listed ticker
Woodside   8      <- listed company name
TLS        7      <- listed ticker, and TLS resolves for 38 members elsewhere
AGO        7      <- listed ticker
```

**Bare tickers and plain company names are failing to resolve**, and TLS failing
here while succeeding for 38 members elsewhere proves the failure is CONDITIONAL,
not a missing listing. Candidates for the cause, in order:

1. `tickerStopwords` or the `private` path swallowing short all-caps candidates.
2. `trailingTickerRe` only firing on a ticker in trailing position, so a candidate
   that is *nothing but* a ticker never sets `c.Ticker`.
3. `normalizeEntityName` mismatching `"Woodside"` against the stored
   `company_name` (the ETF-name mangling in §2.1 is the same class of problem).

This is worth far more than the noise vocabulary: these are real declared holdings
by named members that currently render as "not matched to an ASX listing". Fixing
it should move the gate materially, and it should be measured before anyone argues
about recalibrating the 35% threshold.

### 8.11 Bare tickers were never recognised — gate 20.8% -> 24.7%

Suspect 2 from §8.10, confirmed by probing `makeCandidate` directly:

```
"IAG"  ticker=""  norm="IAG"       <- and so on for QBE, TLS, AGO, BHP, CBA
```

`trailingTickerRe` only fires on a ticker FOLLOWING other text, so a candidate that
is *nothing but* a code never set `c.Ticker`. Those then fell through to name
matching, which cannot possibly work — the listing is "Insurance Australia Group",
not "IAG". Members write the bare code constantly, and it was the single largest
group in the item-1 unmatched pool.

`bareTickerRe` (`^([A-Z0-9]{2,4})$`, whole-string anchored) fixes it. Safe by
construction: `resolveSecurityCandidate` only accepts a ticker that EXISTS in the
listings map, so a 3-letter word that is not a real code still misses. Stopwords
still apply, so a bare "ETF" cannot resolve to UBS IQ MSCI Australia ETF.

| | before | after |
|---|---|---|
| resolved | 1,010 (20.8%) | **1,197 (24.7%)** |
| via ticker_in_text | 141 | **371** |
| via name_exact | 610 | 567 |

`name_exact` falls because those rows now resolve by ticker instead, which is the
stronger signal — the member named the listing themselves.

**The gate is still unmet: 24.7% against >=35%.** Remaining suspect from §8.10 is
`normalizeEntityName` mismatching plain company names ("Woodside" against
"Woodside Energy Group Ltd"), which is the same class as the ETF-name mangling in
§2.1 and is the next thing to measure.

### 8.12 Name-prefix matching is NOT the answer — and would be unsafe

Suspect 3 from §8.10, measured before building anything. Of **2,601** distinct
unmatched item-1 names, treating the candidate as a PREFIX of a listing name would
resolve:

| | |
|---|---|
| exactly one listing (usable) | **23** |
| more than one listing (unsafe) | **28** |

So prefix matching is both immaterial (23 of 2,601 = 0.9%) and **more often wrong
than right**. A prefix hitting two listings attaches a real declaration by a named
member to the wrong company. Do not build it. All three suspects from §8.10 are now
closed: two wrong, one (bare tickers, §8.11) real and fixed.

What the remaining pool actually is:

```
Shares                                        10   noise
Woodside                                       8   REAL - needs a curated alias
AGL Ltd                                        6   REAL - "AGL Energy" - alias
Patron                                         6   not a security
P2P                                            6   not a security
The following shares have been purchased on    6   PROSE FRAGMENT - splitter leak
spouse)                                        5   PARENTHETICAL LEAK
In spouse/partner section                      5   SECTION LABEL LEAK
```

Two levers remain, in order of value:

1. **Splitter leakage.** `"spouse)"`, `"In spouse/partner section"` and
   `"The following shares have been purchased on"` are not securities and should
   never have become candidates. They inflate the denominator exactly as the
   gift/travel terms did (§8.10) — same fix, same file, and this time the evidence
   says the fragments are structural (unbalanced parentheticals, section labels,
   sentence heads) rather than a vocabulary.
2. **Curated aliases** for the genuine long tail (`Woodside`, `AGL Ltd`). This is
   the designed mechanism — `register_resolution_backlog` is the worklist, ordered
   by frequency — and it is deliberately human-in-the-loop because only a person
   should decide that "AGL Ltd" means AGL Energy.

**Do not "fix" the gate by loosening matching.** The 35% threshold was calibrated
on an almost entirely 48P corpus; the 44th and 45th Parliaments contain far more
free text, private companies and foreign holdings that are unmatchable BY DESIGN.
Recalibrate the threshold against the real corpus with evidence, after the two
levers above — never by relaxing what counts as a match, because every relaxation
is a chance to attribute a holding to the wrong named person.

### 8.13 Splitter leakage: partly fixed, and the ceiling is now clear

Two rules added: `giftLogRe` rejects items 11-12 log lines that leak into the
item-1 pool (measured: `"14/11/17 Business Lunch with Bill Shorten Hyatt Regency
Sydney"`, `"$50.00. 13 June"`, `"10 x tickets to attend..."`), and
`sharesInPrefixRe` strips a leading share quantity so a REAL holding
(`"1000 SHARES IN KWINANA COMMUNITY FINANCIAL SERVICES LTD"`) matches instead of
being lost to a length rule.

Gate: **24.7% -> 25.2%**, 112 rows reclassified. Honest assessment: less than the
~510 "prose leak" rows measured, because those are heterogeneous free text rather
than one pattern. Chasing the remainder with more regexes has poor returns and
rising risk — each new rule is a chance to reject a real declaration.

**The composition sets the real ceiling.** Of 3,213 unmatched item-1 rows:

| | rows | can it resolve to a ticker? |
|---|---|---|
| prose / log leaks | ~510 | no — a defect, partly fixed above |
| funds, ETFs, index products | 275 | mostly no — belongs in `unlisted_fund` |
| private companies, trusts, SMSFs | 61 | **no, by definition** |
| foreign (Inc/LLC/plc) | 64 | no — not ASX |
| plausible listings | 2,373 | **yes — the addressable set** |

So ~900 rows are CORRECTLY unresolvable. Forcing them to `resolved` would fabricate
a listed holding for a named person. **100% of candidates is not a target, it is a
bug.** The target is every candidate correctly CLASSIFIED — resolved /
unlisted_fund / not_a_security / genuinely unmatched — with the gate measured
against that denominator.

**On training a custom model.** The bottleneck is not recognition: the vision tier
already reads "AGL Ltd" at 14/14 accuracy. The hard part is deciding it means AGL
Energy Limited, which is entity linking against `company-metadata`, not perception.
And `register_item_securities_public_gate` only permits `curated_alias`,
`ticker_in_text` or `name_exact` to be `resolved` — a learned fuzzy match is
`analyst_fuzzy` by definition and is STRUCTURALLY unpublishable. Using one would
mean weakening the constraint that stops a holding being attributed to the wrong
company, for a named MP, in a plaintiff-friendly defamation jurisdiction. There is
also a bootstrap problem: the training data would be the curated aliases that do
not exist yet, and once they exist the model is redundant.

Where ML does earn its place is **ranking the review queue** — suggest
`"AGL Ltd -> AGL Energy (AGL), 0.94"` and let a person confirm with one keystroke.
That is the review console (`docs/feature/politicians/review-console.md`), and
`gemini-embedding-001` is already wired elsewhere in this repo for it. The model
proposes; the constraint still requires a human to dispose.

### 8.14 Non-listed interests are NOT failures — surface them as what they are

Correction to the framing in §8.13. A family trust, private company or SMSF is a
**real declared interest**, often more editorially interesting than a CBA
shareholding. Treating it as a resolution *failure* is wrong twice: it distorts the
gate, and it misdescribes the data to a reader.

They are already published — **17,923 of 18,799** rows in
`mv_register_public_holdings` carry no ticker, and entries like `"The Indinup
Trust"` do render on profiles. The problem is not that they are missing. It is that
they are UNLABELLED and, in places, DIRTY.

**Two defects visible in a five-row sample of item-2 rows:**

```
"Not Applicable the Member, the Member's spouse, fo…"   <- NIL ROW WELDED TO BOILERPLATE
"The Nirvana Trust The Nirvana Trust"                   <- DUPLICATED (2.i + 2.ii both captured)
```

Both render as garbage declarations against a named person. The first is the form's
explanatory note bleeding into a nil cell; the second is the item-2 sub-table pair
being concatenated rather than kept as two rows.

**The labelling problem.** `DeclaredEntity` renders every unresolved row as
`<text> — not matched to an ASX listing`. For `"The Indinup Trust"` that is
technically true and editorially useless: it reads as a system failure when the
truth is "this is a trust, and trusts are not listed". A reader cannot tell a
private family trust from a company we simply failed to match.

**The signal already exists and is being thrown away.** `aph_resolve.go` computes
`c.Private` (Pty/Ltd/trust/SMSF/nominee detection) and `nonSecurityRe`, then
collapses both into `resolution_status='not_a_security'` — a name that means "not a
LISTED security" but reads as "not real". Nothing persists WHICH kind it was.

**Design:**

1. Persist an `entity_kind` on `register_item_securities`:
   `listed | private_company | family_trust | smsf | managed_fund | foreign | not_an_entity`.
   Derived from the discriminators already computed, so this is plumbing, not new
   inference.
2. Render it as a labelled chip — "Family trust", "Private company", "Self-managed
   super fund" — instead of the "not matched to an ASX listing" apology. Keep that
   wording ONLY for `entity_kind='listed'` candidates that genuinely failed to
   match, which is the case it was written for.
3. Exclude everything except `listed` from the resolution gate's denominator. A
   trust can never have a ticker, so counting it as an unresolved security is a
   category error — and it is a large part of why the gate reads 25.2%.
4. Fix the two extraction defects first: they are wrong facts about named people
   and no amount of labelling helps a row that says
   `"The Nirvana Trust The Nirvana Trust"`.

Order: defects (4) before plumbing (1-3), because the dirty rows are the only part
that is actively misleading.

### 8.15 §8.14 built and measured — and point 3 was wrong

All four points are shipped. Three findings, two of which correct §8.14.

**The two defects had different causes from the ones named above.**

`"Not Applicable the Member, the Member's spouse..."` is not "the form's
explanatory note bleeding into a nil cell" by accident — it is `parse_item_tables`
extending the open cell from ANY band with words right of the label boundary. The
`ii.` sub-item note is indented to x≈55-78 and runs past the value column, so the
last row of sub-table 2.i absorbed it. **437 rows across 436 of 455 born-digital
documents** — effectively every one.

`"The Nirvana Trust The Nirvana Trust"` is NOT "the 2.i and 2.ii sub-tables
concatenated". Both bad lines are inside **2.i**; 2.ii is a separate, correctly
parsed table. The real cause is that the form **centres a holder label against its
own cell**: where the cell wraps to three lines and the label to two, the label's
first line sits BELOW the cell's first line, so "most recent label wins" gave
Spouse/partner's first trust to Self. §2.8 called this a 47P-only trait; it is not
— 48P centres its labels too, and it is invisible until a cell is multi-line.

**The row boundary never had to be inferred: the form draws it.** `page_row_rules`
reads the table's horizontal rules out of the PDF's vectors. On the reported page
the rule at y=322.32 separates the two rows with 16pt of clearance above and 2pt
below, where nearest-label arithmetic was a 0.3pt coin flip. Rules are additive —
absent on a scan, an OCR'd page or a test double, and every comparison
short-circuits, so those paths are untouched. Corpus effect: 437 changed
documents, 753 rows shortened, 274 re-attributed, boilerplate rows 437 → 1.

**Point 3 does not move the gate, and the reason matters.** Measured with
`-mode register-resolve` over the loaded corpus:

| | before | after |
|---|---|---|
| resolved | 1,197 | 1,197 |
| denominator | 4,741 (`candidates - not_a_security`) | 4,739 (`entity_kind='listed'`) |
| **gate** | **25.2%** | **25.3%** |

§8.14 predicted this would move materially "because a trust can never have a
ticker". It does not, because private vehicles were **already** outside the
denominator: `resolveSecurityCandidate` sends every one of them to
`not_a_security` before the count is taken. The change is still right — the
denominator now means what it says instead of meaning it by coincidence — but the
gap to 35% is entirely §8.13's other buckets (funds/ETFs, and plausible listings
awaiting curated aliases). **Do not expect a classification change to close it.**

**What point 1 did change is what gets PUBLISHED.** The fold excluded
`resolution_status='not_a_security'`, which silently withheld every private
company, family trust and SMSF declared under items 1 and 4 — including item 4
(directorships), which turns out to be mostly them. Switching the filter to
`entity_kind <> 'not_an_entity'` publishes 883 holdings that members declared on a
public form and that we already publish under items 2 and 5-14:

| item | listed | private_company | family_trust | smsf | managed_fund |
|---|---|---|---|---|---|
| 1 shareholdings | 3,641 | 356 | 16 | 23 | 2 |
| 4 directorships | 328 | **482** | 8 | 6 | 0 |

Candidate totals (6,335): listed 4,739, private_company 1,078, not_an_entity 454,
smsf 37, family_trust 25, managed_fund 2.

**`foreign` is permitted by the CHECK and deliberately never produced.** The only
available signal is an Inc/LLC/plc suffix, and four of the fourteen such names in
this corpus are Australian incorporated ASSOCIATIONS (`Street Law Centre (WA)
Inc.`, `EMILY'S LIST (AUSTRALIA) INC.`). Labelling those a foreign listing would
be a wrong fact about a named person's directorship, so the value waits for a
curated decision.

**Two things this did NOT do.** The gate above is measured against the
extraction already in the database; the parser fix reaches it only after a
re-extract and re-load of the 455 born-digital documents. And the §2.8
centred-label quarantine still fires on 47P documents that the drawn rules now
attribute correctly — lifting it is a publication decision, not a parser one, and
is the cheapest coverage win left.

### 8.18 An organisation's acronym is a real ASX code — 16 wrong companies published

Found while measuring how to lift resolution. Gift and hospitality prose that had
leaked into the item-1 pool was resolving through the ticker path, because
Australian sporting and institutional acronyms **are** live ASX codes:

```
Anthony Albanese   "pin and a football from the NRL"           -> NRL  Newland Resources
Graham Perrett     "…as the guest of the NRL."                 -> NRL  (National Rugby League)
Peter Dutton       "Tickets … State of Origin 3 NRL"           -> NRL
Peter Dutton       "Tickets … AFL Grand Final courtesy of AFL" -> AFL  Af Legal Group
Peter Dutton       "Tickets to Brumbies vs Waratahs … ARU"     -> ARU  Arafura Rare Earths
Steve Irons        "ROD STEWART CONCERT TICKETS HOSTED BY RAC" -> RAC  Racura Oncology
Steve Irons        "…AFL match … hosted by WCE"                -> WCE  West Coast Silver
M. McCormack       "2 x tickets … Cricket Test at the SCG."    -> SCG  Scentre Group
Sharon Claydon     "Friends of the ABC"                        -> ABC  Adbri
Craig Laundy       "2 Tickets to the Women's Open from NAB"    -> NAB  (a real bank — but a GIFT)
Jason Clare        "Confederation of Indian Industry (CII)"    -> CII  Ci Resources
```

**A stopword list cannot fix this.** NRL, AFL, ARU, RAC, SCG, WCE and ABC are all
real codes, so blocking them would also block a member who genuinely holds one —
and `SCG` is legitimately declared as Scentre Group elsewhere in this corpus.

Two rules, both measured over the whole corpus before shipping:

1. **`giftProseRe`** rejects hospitality prose from the item-1/4 candidate pool
   (tickets, hospitality, courtesy of, hosted by, guest of, grand final, state of
   origin, concert…). It un-resolves **14 rows and all 14 are wrong facts**; no
   genuine holding matches it. It deliberately EXCLUDES a bare `flight` — `FLT` is
   Flight Centre Travel Group and appears inside real SMSF share lists; only the
   phrase `flight upgrade` is a gift marker.
2. **`selfGlossedAcronym`** stops a parenthesised code being trusted when it is
   merely the initialism of the words before it. `"Confederation of Indian
   Industry (CII) - Tie"` is a trade body glossing itself, not a member quoting a
   ticker. This is a ticker-path block, NOT a rejection: the gloss is stripped and
   the candidate falls through to the NAME path, so
   `"Commonwealth Bank of Australia (CBA)"` still resolves to CBA and
   `"Insurance Australia Group (IAG)"` still resolves to IAG — both verified.
   A first attempt that blocked the ticker WITHOUT stripping the gloss normalised
   to `COMMONWEALTH BANK OF AUSTRALIA CBA`, which matches no listing; the test
   caught it before it shipped.

Item-1 resolution moved **27.58% → 29.25%** as a side effect — the denominator
shrank because these rows were never securities. The gate is still unmet.

> **The gate is also MIS-COMPUTED.** §6.1 calls it "item-1 security resolution",
> but `runRegisterSecurityResolve` selects `WHERE item_no IN (1, 4)` and the
> headline divides by that. §3.4 says in terms that item 4 "must not sit in the
> headline denominator" — item 4 resolves at **1.2%** (5 of 407) because
> directorships are overwhelmingly private companies. Reporting item 1 alone, as
> the doc already says it should, is **26.60% → 29.25%** and changes nothing that
> is published. Fix the metric before tuning against it.

### 8.19 The CELL says whether it is a shareholdings list — use that, not keywords

§8.18 fixed the NRL class with a vocabulary. Vocabularies are whack-a-mole, and
the document already carries the answer: **a shareholdings cell looks nothing
like a gift log**, and every candidate has siblings that say which one it is.

Measured over item 1, with a signal computed WITHOUT reference to whether
anything resolved (a corporate suffix, a fund-issuer name, or a candidate that
IS a validated ASX code):

| cell | cells | candidates | resolved |
|---|---|---|---|
| carries a company signal | 792 | 2,551 | **1,077 (42%)** |
| carries none | 1,817 | 2,501 | 108 (4.3%) |

A read of 40 random unresolved candidates from the no-signal cells found
*"Bunch of flowers"*, *"Small pewter mug"*, *"Tea Towel"*, *"battery operated
candle"*, *"BBC branded laptop sleeve"*, *"Extra Virgin Olive Oil Soap x 2"*,
*"Lindt Selection Chocolates"*, *"Qantas Chairman Lounge"*, *"Upgrade of room @
Relais spa Roissy Hotel"*, *"approx. value $30 received on Thursday 14th
February 2019."*, *"VISA DEBIT ACCOUNT"*, *"Byron Bay 17 to 21 April"*. **One**
named a security, and it was Meta — a NASDAQ listing, correctly unresolvable
here. These are not missing aliases. They are items 11/12 that the 44P/45P scans
filed under item 1, and every one of them was rendering on a named member's
profile as "— not matched to an ASX listing".

**The rule only ever reclassifies a candidate that FAILED to resolve.** A
candidate matching an alias, a stated ticker or a listing name keeps its
resolution and stays `listed`. Verified: resolutions were **1,190 before and
1,190 after**, with the method split byte-identical (620 name_exact / 321
ticker_in_text / 249 curated_alias). It removes padding from the denominator; it
cannot remove a match.

Two corrections came out of auditing the first cut, both from reading the
removed rows rather than trusting the aggregate:

- **`"VAS Vanguard"` was being removed** — a genuine ETF holding. A cell can be a
  holdings list with no corporate suffix anywhere in it, so fund-issuer names
  (Vanguard, BetaShares, iShares, VanEck, SPDR) and `P/L` are company signals too.
- **Item 4 was in scope and should not have been.** Directorships are
  overwhelmingly unlisted bodies BY NATURE — `"Art Gallery Society of NSW"`, a
  school board, a charity — and §8.15 decided deliberately that those are real
  declared interests worth publishing. Applying a shareholdings-shaped test to
  them withholds exactly the rows that change was made to surface. **The rule is
  item 1 only.**

Gate, item 1: **30.66% → 50.32%**, with the numerator constant.

> **THIS IS A DENOMINATOR CHANGE AND MUST BE REVIEWED AS ONE.** That review has now
> happened — see §8.19.1. Its verdict: the reclassification is **not** gaming, but
> **"the gate is met" may not be reported**, and three of the numbers in this
> section were wrong.

### 8.19.1 The independent audit — and what it corrected

Three independent lenses re-sampled the removed set on PROD with their own seeds,
then a fourth adjudicated. Verdict: **honest-with-caveats.**

**The reclassification is not gaming.** Uniform draws found **0 securities in 40**,
**0 in 80** and **0 clear securities in 60**. For the gate to fall back to 35%,
**68.3%** of the removed rows would have to be real securities; measured leakage is
**2-3%**, upper bound ~10%. And the errors point BOTH ways — 44% of a random 50 rows
the rule KEEPS are also not securities, which inflates the denominator and works
*against* the gate. A change engineered to move a number does not do that.

**Three numbers in §8.19 were wrong, and are corrected here:**

| §8.19 said | Actually |
|---|---|
| 2,501 candidates removed | **1,510** — the other ~991 were already `not_a_security` before this change |
| baseline 27.58% | **30.66%** (`1185/3865`). 27.58% does not reproduce on prod and §9 said 25.2% — three "before" numbers for one change |
| 50.32% | **~49%**, band 42.8-49.6%, after correcting both sides |

**The audit found defects, all now fixed, each verified on prod:**

1. **Hospitality published as a holding.** `splitFragments` cuts on commas, so
   `"Qantas, Flight upgrade, 16 March 2018, Cairns-Sydney"` yields a bare
   `"Qantas"` → QAN. Live on prod: **David Coleman QAN/VGN×3/NEC, Greg Hunt
   QAN/VGN, Julian Hill VGN, Nick Champion VGN** — flight upgrades and a dinner
   published as CURRENT shareholdings. `giftProseRe` is now tested against the
   whole CELL, which poisons every fragment in it.
2. **28 genuine declarations deleted from the denominator** because the code sat in
   a position no ticker path reads: `IVV - self and spouse`, `FMG Fortescue`,
   `JBH JB HiFi`, `WES Wesfarmers`, `CBA (Jointly held with spouse)`, `ORI`, `S32`,
   `WPL`, `APT- After Pay Touch`, `SYD- Sydney Airport Staple`. A validated ASX
   code ANYWHERE in the text is now a cell signal. Safe here where it is not for
   RESOLVING: it only keeps a row in the denominator, so a false positive costs an
   unmatched row — never a wrong company.
3. **Two regex holes**: `shares` was plural-only (`Unilife Share Sold` missed by one
   letter) and `\bbank\b` misses `Commonwealth Banking of Australia`.
4. **The alias proposer was blind to 1,301 names.** It filtered
   `entity_kind='listed'`, so the rule's own output was invisible to the one lever
   §9 names for raising resolution. A name the classifier cannot explain is exactly
   what a human should be shown.
5. **The rule had ZERO test coverage.** No test set `ItemNo`, so the `c.ItemNo == 1`
   arm never fired — the code that moved the headline could have been deleted
   without failing anything. `TestCellContextRule` now covers all five cases.

After the fixes: **1,181 / 2,367 = 49.89%** locally — landing on the audit's
independent estimate.

> **THE GATE ITSELF IS THE REAL FINDING, and it is a doc bug rather than a fraud.**
> §6.1's denominator is `entity_kind='listed'`, which the code assigns **by default
> to anything it cannot otherwise explain**. On prod item 1: `foreign` = **0 rows**,
> `managed_fund` = **2**, `unlisted_fund` = **0** — those constants are essentially
> unused. So §8.13's whole backlog of CORRECTLY unresolvable declarations (foreign
> listings, ETFs, delistings) still sits inside the denominator, and merely
> classifying it — zero new matches — would lift the gate toward **~80%**. A metric
> that travels 30.66% → 49.89% → ~80% with the numerator frozen is measuring our
> ability to EXPLAIN failures, not to RESOLVE them. §8.13 already said the target
> should be "every candidate correctly classified"; §6.1 was never updated to match.
> **Report ~49% with the band and the method, never "the gate is met".**

Residue: 3 gift rows still publish under item 1 because their cell ALSO contains
something company-shaped (`"bottle of wine from the TWU"`). A cell-level rule
keeps everything in a mixed cell, by design.

### 8.19.1 The alias proposer — the model proposes, a human disposes

`-mode register-propose-aliases` (`aph_alias_propose.go`, migration `000100`)
turns "1,800 unmatched names" into "1,800 one-keystroke decisions, ordered by how
many rows each fixes".

It cannot publish anything. `register_item_securities_public_gate` permits
`resolved` only for `curated_alias`/`ticker_in_text`/`name_exact`, so a model's
answer is `analyst_fuzzy` by definition. Proposals land in
`register_alias_proposals`, which **no resolver and no read path reads**;
`-mode register-promote-aliases` copies only rows a human marked `confirmed`,
recording who and when.

Two design choices that matter:

- **The shortlist is computed deterministically here, not by the model.** The
  model only ever CHOOSES FROM a list we built by token overlap, or answers NONE.
  It is never asked to recall an ASX code from memory, which is where a
  hallucinated ticker comes from. The answer is then validated twice: the code
  must exist AND must have been on its own shortlist, or it is recorded as NONE.
- **The shortlist is stored with the answer**, so a reviewer can see what the
  model was offered. A proposal without its alternatives is not reviewable.

First run over the real backlog — the good and the bad, both instructive:

```
WOODSIDE        x9 -> WDS   AGL ENERGY x7 -> AGL   SYDNEY AIRPORT x6 -> SYD
LYNAS           x5 -> LYC   NEWS       x5 -> NWS
COCA COLA AMATIL x6 -> NONE  "acquired by Coca-Cola Europacific and de-listed"
CYBG            x5 -> NONE  "delisted in 2018 following its acquisition"
VIRGIN          x5 -> NONE  "too ambiguous to map to a single current listing"
PATRON          x6 -> NONE  "does not clearly map to 'Patronus Resources'"
FLIGHTS         x5 -> FLT   <-- WRONG. The NRL class again.
```

It correctly refused every delisted and ambiguous name — including the `CCL`
recycling trap the plan warned about — and then proposed **FLIGHTS → Flight
Centre**, reasoning that "flights" is how Australians refer to it. That is a
gift-log entry, and it is precisely why a human confirms every row. The
underlying leak is now closed at source (`flights?` is anchored whole-string in
`nonSecurityRe`, while `"Flight Centre Travel Group"` is untouched), but the
lesson stands: **the proposer is a queue-ranker, not an oracle.**

### 8.20 The 14 form items as a compact tag

"Other declared interests" rendered the form's LEGAL wording against every row —
"Family and business trusts and nominee companies", "Bonds, debentures and like
investments". Accurate, and unreadable in a dense table.

`web/src/@/lib/politics/register-items.ts` gives each of the register's 14 items
an icon and a short label; `RegisterItemTag` renders `🗂️ Trusts`, `🎁 Gift`,
`✈️ Sponsored travel`, `💼 Directorship`, with the form's own wording kept as the
tooltip so a reader can still find the numbered item on the original PDF.

It is the SOURCE'S taxonomy, not one we invented — the form asks for exactly
these fourteen things in this order, so no row needs classifying to be tagged.

**Every row also links to the document it came from.** `SourceDocLink` renders a
per-row `45P ↗` to the original APH PDF. The page previously rendered ONE link
built from `interests[0].sourceUrl`, which on a member spanning five parliaments
cited the wrong document for every row but the first — worse than no citation,
because it invites a reader to check a claim against a PDF that does not contain
it. Measured on Mark Butler (44P-48P): 1 linked PDF became 5, across 108 per-row
links. The page-level `SourceLine` keeps the attribution, as-at date and "report
an error", and offers a PDF only when every row genuinely shares one. The label
is derived from the URL, which encodes the parliament twice; Senate volumes are
`/-/media/<GUID>.ashx` and fall back to "PDF" rather than guessing.

**The iconography is governed by the editorial standards, and the test enforces
it.** Rule 2 covers icons beside a named person and rule 5 forbids implying
value, so `register-items.test.ts` asserts that no item uses a currency glyph
(💰/💵/🪙/💲) or a warning glyph (⚠️/🚨/🔴/🚩/👀). That is why item 10, "other
substantial sources of income", is `📥` and not a money bag: the category is
"income received", and the icon may say no more than that. The emoji is
`aria-hidden` and the label carries the meaning, so a screen reader hears "Gift",
not "wrapped present Gift". An unknown item renders NO tag rather than a
placeholder — inventing a category would be a claim about what the member
declared.

### 8.21 The backlog gets a screen — and the lever was broken all along

§9 named **curated aliases via the review console** as one of the two legitimate
ways to raise resolution. The console did not exist, so the lever had never been
pulled. What was found on picking it up:

**`promoteAliasProposals` could never have worked.** It writes
`INSERT INTO register_security_aliases (… , notes)`; the column is **`note`**.
The one path from a human-confirmed proposal to a published link was broken from
the day it was written, had **zero test coverage**, and was green the whole time —
because nothing had ever been confirmed. There was no UI to confirm with, so the
statement had never executed. Verified against the real schema, then fixed.
`register_review_console.test.mjs` now asserts every column that statement names
against the migration's own `CREATE TABLE`, which is the check that generalises.

**Both halves of coverage are one table.** `aph_resolve.go` reads
`register_security_aliases` and nothing else, so a row there is the single
control surface for both directions the gate can move:

| Decision | `resolution` | Effect on §6.1 |
|---|---|---|
| resolve to a code | `resolved` | numerator up — a real new published link |
| unlisted/wholesale fund | `unlisted_fund` | denominator down — `managed_fund` |
| names nothing held | `not_a_security` | denominator down — `not_an_entity` |
| listed, not on the ASX | `foreign` **(new)** | denominator down — `foreign` |

`foreign` is new to the CHECK. `entityKindOf`'s own comment said the constant
"waits for a curated decision rather than a suffix guess" — but there was no way
to record that decision, so `alias_kind='foreign'` fell through to
`not_a_security` and labelled a real foreign listing as naming nothing at all.
Measured on prod at the time: `foreign` = **0 rows**. The kind is now PINNED by
the alias rather than derived from the status, because `foreign` and "names
nothing" share the status `not_a_security` — deriving over the top of it discards
the human decision.

**Measured queue, 2026-07-31 (local):** 2,070 undecided names across 2,638 rows.
The slice that can move the gate is **814 names / 1,120 rows**; 208 of those
names occur more than once and account for 514 rows. The head is real but thin —
`REFER ATTACHED` ×12, `SHARES` ×10 across 4 members, `WOODSIDE` ×9 across 4,
`SYDNEY AIRPORT` ×6 across **5**.

**What the screen does that a list could not.** `register_resolution_backlog`
(000096) is name + example + count: enough to ORDER the work, not enough to
DECIDE it. `register_review_security_queue` (000101) adds the blast radius in
NAMED PEOPLE, the parliaments and items, whether the candidate is inside the gate
denominator at all, and the real `declared_text` strings with a per-row APH link.
A reviewer deciding `SYDNEY AIRPORT` is deciding for five named members at once,
and the screen says so before the keystroke.

**Guards, all verified against the running service:** an invented code is
refused (`ZZZZ` → `invalid_argument`); a `tickerStopwords` code is refused
without a second confirmation (`ETF` → the trap that once published ten members
as holding a fund none had declared); `curated_by` is read from the request
header, never the body; and the decision vocabulary is a **closed proto enum with
no fuzzy member**, so the UI cannot offer and the server cannot receive the one
`match_method` the public gate forbids.

**The console publishes nothing by itself.** A decision writes one alias row;
the next `-mode register-resolve` applies it. Undo deletes the row and returns
every candidate to `unmatched`, the honest pre-decision state.

Not built, and stated rather than hidden: §7.4 rule 4's **second admin** for
high-fanout aliases (`occurrences >= 20`) needs a `needs_second_review` column
and a `confirmed_by <> corrected_by` CHECK. The console instead forces a
blast-radius confirmation dialog above a threshold — one admin can still make the
call. Screens (a) and (c), the corrections ledger, the page-image server and the
publication-gate flip (steps 2, 4, 7, 9, 11 of the console plan) are untouched.

### 8.22 The explorer: search, and the aggregate shape of the register

`/politicians` was a hub with a 60-card grid. It is now search-first, over the
SAME published data, with two analytic views beside it.

**Search runs on the existing Algolia integration**, not a new one. A new
`politicians` index is built by `shorted influence -mode register-index` from
`mv_register_public_holdings` — the same view the public read path uses, so the
index CANNOT contain a row the site would not already serve. Nothing in the
indexer touches `register_declared_items` or `register_item_securities`; a search
index is a second read path, and §8.16's lesson is that a second path trusting
its own filter is how a withheld row gets published.

Two changes to the shared Go proxy (`/api/algolia/search`) made it usable:

- **The index is now allowlisted rather than hardcoded.** The handler holds the
  Algolia key, so a caller-supplied index name would turn it into an open read
  proxy for every index on the application. `stocks` and `politicians` are the
  only accepted values; anything else logs and falls back, so a stale client
  degrades instead of breaking. Verified: `company-metadata-private` served
  stocks, `politicians` was forwarded.
- **An empty query no longer 400s.** Algolia treats `""` as "match everything",
  which is exactly what a facet-driven browse opens with. Rejecting it forced
  callers to send a junk query, which changes both the ranking and the facet
  counts they get back.

**`GetPoliticianAnalytics`** (dual-added to the legacy service, per the parity
test) returns the party x industry matrix, the industry and party axes, and the
state split. Every figure is a COUNT OF PEOPLE or of COMPANIES:

- **People, not rows.** A member declaring four banks is one person. Counting
  rows would make a diversified portfolio look like political concentration.
- **`companies` rides beside `people` in every cell**, because "46 members
  declare Telstra — one company" and "45 members declare 52 different Materials
  stocks" are completely different facts that one intensity value cannot
  separate, and the first is the one a reader will over-read.
- **A blank party stays blank.** Party is not on the APH listing; it arrives via
  an electorate join and is genuinely absent for some members (locally the
  largest single group). It renders as "Not recorded" everywhere — never
  "Independent", which would attribute a party to named individuals.
- **The industry cap reports what it dropped.** Showing 14 of 25 industries
  without saying so reads as the whole picture.

The heatmap uses ONE SEQUENTIAL HUE — the house amber, sampled from the same
`interpolateOranges(0.18 + 0.74t)` expression `amberScale()` uses, hardcoded as
six steps so the route does not pull d3 (~20kB) for a bucketed chart. Not a
red-to-green diverging ramp: diverging implies a good end and a bad end, and rule
2 forbids that framing beside a named person. A zero cell gets NO ink rather than
the palest amber, so absence cannot read as faint presence. Every populated cell
prints its value and a table view exists — the pale steps fall below 3:1 against
the surface, and that obligates relief rather than being a warning to dismiss.

**A prerender failure this cost a build to find, and now a test prevents.** The
explorer first imported `PartyChip` from `compliance.tsx`. compliance has no
`"use client"` and imports `RegisterHolder` from the generated protobuf module,
so a CLIENT component importing it dragged `@bufbuild/protobuf` across the
boundary and the whole static build of `/politicians` died with

```
Error: Element type is invalid: … but got: undefined.  digest: '2911474217'
```

— minified, with no file name. **Every jest test passed while the build failed**,
because jest resolves the module graph without the RSC client boundary. The fix
is `@/lib/politics/party-palette`, which was split out for exactly this reason;
`client-boundary.test.ts` now asserts it structurally, and exempts only the one
component that is genuinely `ssr:false` (checking the loader really is).

`/politicians` stays **static ISR** — 12 kB / 137 kB first load. Query state
lives in the URL and is read client-side under Suspense; reading `searchParams`
in the server page would silently flip the route to dynamic. The complete member
roll is still server-rendered inside a `<details>`, so every profile URL stays in
the HTML for a crawler that never runs the search.

**Ops — one command, credentials from `services/.env`:**

```
make register-index-env    # which Algolia creds are visible (values masked)
make register-index-dry    # reads the DB, writes NOTHING
make register-index        # builds + pushes
make register-index ALGOLIA_POLITICIANS_INDEX=politicians_dev   # scratch namespace
```

`services/.env` is gitignored; the keys are documented in `services/.env.example`.
**The write key is not the search key** — the search key is served to browsers and
cannot create an index, so the target refuses up front with that message rather
than letting Algolia return a permissions error halfway through.

**The `DATABASE_URL` re-export in that target is load-bearing.** `services/.env`
holds the PRODUCTION Supabase URL — it is the file operators use for prod DDL —
so sourcing it for the credentials would silently point a "local" index build at
prod. The target re-exports the Makefile default afterwards, exactly as
`run.shorts` does, and prints the (password-masked) database it is about to read
so the target is visible before anything is written. Pass `DATABASE_URL=…`
explicitly to target prod deliberately.

Run it AFTER `register-resolve`: it reads `mv_register_public_holdings`, which
resolve rebuilds, so an index built first advertises stale matches.

Verified end to end against a throwaway `politicians_dev_verify` index (since
deleted): 324 records in 2.8s, facets populated (`party_ab` ALP 94 / LP 19 /
LNP 16, `state_code` NSW 96 / VIC 77, `has_interests` 165 true / 159 false), and
a search for "Woodside" returned the 7 members who declare it, ordered by the
custom ranking.

### 8.23 Portraits — and why they do not come from aph.gov.au

Every sitting member has a portrait on aph.gov.au. We do not use it, and the
reason is §3.1's own posture: extracted **facts** are publishable with
attribution, the source's artefacts must not be mirrored, and the GCS bucket is
kept private precisely so "we do not maintain a mirror" is true in fact. A
portrait is an artefact, not an extracted fact — and photographs are the likeliest
part of that corpus to carry a photographer/AUSPIC copyright on top of the
Commonwealth's. Serving one from our infrastructure is the exact thing that
posture exists to prevent.

(It was not even available: **`aph_mpid` is 0 of 324 populated**, despite §2.2
calling it a stable person id. The load never writes it, so the natural key to
those images does not exist in our data.)

**Source: Wikidata P18 → Wikimedia Commons.** Commons requires a free licence by
policy — it does not host fair-use files — which is why P18 is materially safer
than an English Wikipedia page image, where a local fair-use upload is possible.
Measured: a 20-person sample of enwiki page images returned an *unknown* licence
for 3 of them; every P18 target resolves to Commons.

**The match is a composite key, never a text search.** A name search over
Wikipedia matched "Anthony Smith" to **Dean Smith** — a different sitting member.
Publishing someone else's face beside a named person's declared interests is the
worst version of the wrong-fact class this subsystem keeps paying for. So the key
is **surname + electoral division**, and any ambiguity WITHHOLDS.

Measured on this corpus: **241 of 324 (74%)** resolved, **1 withheld** as
ambiguous, 13 distinct licences (CC BY 4.0 ×69, CC BY-SA 4.0 ×45, CC BY 2.0 ×30,
CC BY 3.0 ×19, public domain ×18, CC0 ×12, …).

**Attribution is enforced in four places, because it is a licence obligation
rather than a caption.** CC BY and CC BY-SA permit publication only WITH the
credit and a link to the terms, so an unattributed portrait is a breach:

1. `politicians_photo_needs_attribution` CHECK — the database cannot hold a photo
   without a licence and a source URL
2. `scanPolitician` blanks the URL if either is missing, so a future partial
   SELECT cannot recreate the state
3. the proto carries the four fields together, and the Algolia record does too
4. `PoliticianAvatar` refuses to render an image it cannot attribute, and
   `PortraitCredit` renders the credit beside the face

The credit also states **"Not a Parliament of Australia image"** — on a
register-of-interests page a reader would otherwise assume an official portrait.

**The fallback is a designed state, not a broken one.** ~26% have no freely
licensed portrait, so they get a party-tinted **monogram** carrying their
initials — never a generic silhouette (which reads as "person unknown" about
someone we have named) and never another person's photograph.

**No `next/image`.** Its `remotePatterns` allowlist crashes the whole route for
an unlisted host, and these URLs come from a third party whose shards we do not
control. A plain `<img>` with explicit dimensions cannot take a page down, and
Commons already thumbnails to 400px.

**Ops:** `make register-photos` (or `register-photos-dry`). No credentials —
Wikidata and Commons are open; the collector sends the contactable User-Agent
they ask for. Independent of the register pipeline and safe to run any time: it
writes only the `photo_*` columns and never touches a declaration.

---

## 9. Next steps, in priority order

State at handoff (2026-07-27): branch `feat/politician-register-of-interests`,
unmerged. 769 House documents fetched onto
`/Volumes/gamma-systems-2/shorted-crawl/aph-register`. **324 politicians, 2,757
statements, 20,198 declared rows, 0 unresolved identities, 18,900 holding
intervals, 18,900 published rows across 319 people.** Coverage 44P/45P/48P 100%,
46P 71%, 47P 63%.

§8.16 is **CLOSED** (§8.17): the hidden-listing blocker and five further
wrong-fact defects it did not name are fixed and re-measured to zero. The fix is
a withholding quarantine, not the splitting §8.16 prescribed — that was measured
and rejected for manufacturing new wrong facts.

**Blocking the merge** (the gate is a MERGE gate — see §"The launch gate"):

1. **Security resolution 25.2% vs the >=35% gate** (24.7% → 25.2% → 25.3% →
   25.2%; four successive changes have moved it by fractions of a point). §8.17
   removed wrong facts and was never going to add matches. The two levers left
   are the ones §8.12 named: **curated aliases for the long tail** (`Woodside`,
   `AGL Ltd`) via the review console, and recalibrating the threshold against
   the real corpus — 35% was set on an almost-entirely-48P corpus, and 44P/45P
   carry far more free text and unmatchable-BY-DESIGN holdings. Recalibrate with
   evidence; do NOT loosen matching to hit the number (§8.12 records why).
2. **Editorial template review** against rules 1-8, outcome recorded (who / when /
   commit). §6.2 has the per-rule state; rules 1, 3, 5 and 8 are already enforced
   by `editorial-copy.test.ts`. Re-run it against the §8.17 copy changes:
   `DeclaredEntity` no longer apologises outside items 1 & 4, and `HolderBadge`
   has new "Holder not stated" copy.
3. **The §8.17 open list** — nine items, five of which are still-published
   imperfections rather than wrong facts. Read it before signing off; items 2
   (amendment notices in items 2/5-14) and 5 (a named minor) are the two a
   reviewer is most likely to object to.

**The feedback loop:** `analysis/notebooks/register_quality.ipynb` — a per-document
quality scoreboard, one detector per known failure class, a `inspect_document()`
drill-down that prints what we extracted beside the source URL and the local PDF,
and a `flag()` that appends to `register_feedback.csv`. Needs only pandas +
psycopg2 (deliberately no SQLAlchemy — the kernel does not have it). Runs clean
end to end; 218 of 769 documents carry at least one quality signal.

**High value, not blocking:**

3. **Review console** — `docs/feature/politicians/review-console.md`, 13 ordered steps.
   Build the securities screen first: 3,636 unmatched rows collapse to ~2,601
   distinct names with a repeating head, so a few hundred aliases moves item 1
   above. Verify `ocr_parse_gates()` (dead code today) before step 0.
4. **46P/47P centred-label quarantine** (§2.8) — 88 documents. The vision tier now
   exists and reads these layouts correctly, so re-running `--stage vision` over
   the `partial` set may simply clear it. Measure before parser work.
5. **Senate**: 35 tabled volumes, still unfetched. Needs the `Form A` splitter
   (§1.3), not the per-member path.

**Ops, before prod:**

6. `GEMINI_API_KEY` into GCP Secret Manager, injected into the job like
   `DATABASE_URL` (§8.7). **The key used during development was pasted into a chat
   transcript and must be rotated.**
7. First prod run of `-mode register-discover` is manual, and `REGISTER_DRY_RUN`
   defaults true — see §5.2.

### 8.16 BLOCKER — the entity_kind fold change publishes hidden shareholdings

Adversarial review of §8.15 returned a **major** finding. `aph_periods.go:94` now
gates the fold on `entity_kind <> 'not_an_entity'` instead of
`resolution_status <> 'not_a_security'`. That publishes multi-entity candidates
which NAME REAL ASX LISTINGS while being chipped as a super fund — so the label
hides the shareholding behind it, against a named member:

```
Sarah Henderson  "Santos Ltd. Held by SMH Superannuation Fund: Amcor Ltd"   -> chip: SMSF
Ross Vasta       "Superannuation Fund - Listed Companies: VCX"              -> chip: SMSF   (VCX = Vicinity Centres)
Ross Vasta       "Spouse / Partner: Superannuation Fund ... TNE"            -> holder=unspecified   (TNE = TechnologyOne)
Meryl Swanson    "Cybg PLC (jointly owned with spouse indirectly via Self Mana…"
```

Two distinct faults: a real listing rendered under a label that denies it is one,
and a holder attributed `unspecified` when the row's own text says
"Spouse / Partner". Both are wrong facts about named individuals.

It passed every aggregate check — gate moved 25.2% -> 25.3%, tests green, chips
rendered. That is the shape of this failure: it looks like success in the numbers.

**Fix, in order:**

1. **Revert or re-gate `aph_periods.go:94`.** The parser fixes in `b769bf24c` are
   sound and SEPARABLE — keep them. It is only the fold's inclusion rule that is
   unsafe.
2. **Split multi-entity candidates before classification.** `"Santos Ltd. Held by
   SMH Superannuation Fund: Amcor Ltd"` is two listings and a fund, not one SMSF.
   `splitSecurityBlob` already exists; these strings are reaching `entityKindOf`
   unsplit, and a whole-string classifier cannot be right about them.
3. **Do not classify a candidate whose text names a ticker or a listed company.**
   A vehicle marker ("Superannuation Fund", "Trust") must not outrank an explicit
   listing in the same string — that ordering is what produced these rows.
4. Re-run `--stage extract` + `register-load`: `mv_register_public_holdings` still
   holds the pre-fix item-2 text, so the two §8.14 strings persist until it lands.

**Do not merge PR #364 until 1-3 are fixed and re-reviewed.** The §6.1 launch gate
was already unmet at 25.3%; this is a second, independent blocker and a more
serious one, because it is a wrong fact rather than a missing match.

Method note worth keeping: the implementer's own report said all four parts were
complete and verified. The defect surfaced only because a separate reviewer was
told to REFUTE the work and queried the database for real rows instead of trusting
the report. Both of the §8.14 diagnoses this work was based on also turned out to
be wrong. Assume the report, not just the code, needs independent checking.

### 8.17 §8.16 closed — and the fix is WITHHOLDING, not splitting

Four independent investigations of the loaded corpus, each with an adversarial
reviewer instructed to refute it, closed §8.16 and found **five further defects
of the same class that §8.16 did not name**. One reviewer built a byte-faithful
Go model of `splitFragments`/`makeCandidate`/`resolveSecurityStatus` that
reproduces all 6,335 candidates' `resolution_status` + `stock_code` +
`match_method` with zero mismatches; where it disagrees with a SQL
approximation, it wins.

**§8.16's own prescription was wrong in two of its three parts, and the reviews
are what caught it.**

| §8.16 said | Outcome |
|---|---|
| 2. "Split multi-entity candidates before classification" | **Rejected.** No splitter recovers the row §8.16 leads with, and every splitter tried manufactured NEW wrong facts. |
| 3. "Do not classify a candidate whose text names a ticker" | **Rejected as written.** A token scan measures 14.5% precision. |
| 1. "Revert or re-gate `aph_periods.go:94`" | **Re-gated**, not reverted. |

**Why splitting is the wrong tool.** `abbreviationTail` refuses the `. H`
boundary in `"Santos Ltd. Held by SMH Superannuation Fund: Amcor Ltd"` — and it
is RIGHT to, because `"Pty. Ltd."` must not split. Adding a corporate-suffix
boundary cuts `"Astra … Ltd Citigroup (USA)"` into a standalone `"Citigroup
(USA)"`, which resolves `USA` to **UraniumSA** and publishes a live wrong link;
it also splits `"Far Ltd FPO"` — the example `securitySuffixRe`'s own comment is
written around — into two published rows. A colon separator resolves
`"Class: Limited By Guarantee"` to **CL1** by `name_exact`, which
`tickerStopwords` cannot stop because it never gates the name lookup.

**Why a ticker scan is the wrong tool.** Of 55 (row, token) pairs where a
vehicle-chipped candidate contains a validated ASX code, 8 are real. The rest
are ordinary company names: `ACN` (Acer Energy) in nine `ACN 119 455 xxx Pty
Ltd` strings, `ICE` (Icetana) in `Venice Ice Pty Limited`, `RHT` (Resonance
Health) in `RHT Investments (Qld) P/L`, `VAN` in `Van Manen Investments`.
Relabelling those a listing is the same wrong-fact class pointing the other way.

**So a multi-entity cell is WITHHELD.** `entity_kind='multi_entity'` (migration
`000099`) says what it is — several entities, so no single label is true — and
the fold drops it exactly as it drops `not_an_entity`. It costs **12 candidate
rows**; every one is a genuine multi-entity blob, and all four strings §8.16
names are among them. The detector is scoped to candidates that would otherwise
be chipped as a **vehicle**, because that is the chip that actively denies a
listing beside it.

The suffix arm is a **RATIO** (`Ltd|Limited` > `Pty|P/L|proprietary`), not a
count, and the distinction was measured: requiring only "≥2 Ltd" reads as
multi-entity but would have withheld **47 correctly-labelled private-company
rows** — Angus Taylor's `"Growth Farms Pty Ltd (via Gufee Pty Ltd)"`, Ken
O'Dowd's three companies — for no safety gain.

#### What else was live, none of it in §8.16

| # | Defect | Rows | Cause |
|---|---|---|---|
| 1 | `entity_kind='listed'` **fabricated outside items 1 & 4** | **666** published, **3,174** in the changes feed | The fold hardcoded `'listed'` in the item-3 and items-5-14 arms. Only items 1 and 4 have a security candidate; nothing else was ever classified. `DeclaredEntity` keys the apology off `'listed'`, so `"REST superannuation fund"` and Qantas lounge memberships each read "— not matched to an ASX listing", reporting a match failure that could not have happened. |
| 2 | **A fabricated ETF holding** | 1 | `SELF` is a real ASX code (SelfWealth SMSF Leaders ETF). A holder label left in the value column resolved through `ticker_in_text` and published as Susan Templeman's directorship. |
| 3 | **A private company linked to a live ticker** | 1 | `normalizeEntityName` strips `" LTD"` then `" PTY"`, so `"Endeavour Pty Ltd"` → `ENDEAVOUR` → matched **Endeavour Group** and published `/shorts/EDV` against a member's spouse's private company. The `c.Private` veto sat *below* the name lookup. |
| 4 | **Amendment notices published as CURRENT interests** | 42 | `"please remove Listed Companies: VTG"` carried a **live VTG link**; `"Delete Branyan Investments Pty Ltd"` published as a current directorship; `"Sale of Real Estate in Spearwood WA"` as current property. Each asserts the OPPOSITE of what the member wrote. |
| 5 | **A member's minor children named as company interests** | — | `"daughter Poppy Hunt and son James Hunt"` and `"wife Louise Howarth."` rendered under "Declared company interests", `currently_declared=true`. Editorial §4 puts family members out of scope. |

Defect 1 is the largest by volume by 240×, and it is the exact failure
`DeclaredEntity`'s own doc-comment says was fixed in §8.14 — fixed for items
1 and 4, reintroduced everywhere else by a hardcoded literal two files away.

Defect 5's second instance was a **mangled locality**, not a bare label:
`splitLocalityAndState` takes the first comma-part, so
`"Self, Residential, Canberra, ACT July 2023"` published a property in a place
called **"Self"** — and lost the real suburb, Canberra, sitting later in the same
line. `"Partner residential property St Albans"` likewise. Rejecting these
withholds the wrong fact; it does **not** recover the suburb, which needs a
smarter locality picker with its own failure modes.

#### Measured, before and after

| Assertion | Before | After |
|---|---|---|
| vehicle chip denying a listing named in the same cell | 14 | **0** |
| `entity_kind='listed'` fabricated outside items 1 & 4 | 666 | **0** |
| amendment notice published as a holding (items 1/3/4) | 42 | **0** |
| bare or mangled holder label published (items 1/3/4) | 13 | **0** |
| private company carrying a live ticker link | 1 | **0** |
| `"X X"` duplicated item-2 text (§8.14) | present | **0** |
| boilerplate weld (`Not Applicable` + prose) | 296 | **2** |
| item-1 security resolution | 25.3% | **25.2%** |

Corpus after re-extract + load + resolve: **324 politicians, 2,757 statements,
46,219 item rows (20,198 declared), 0 unresolved identities, 18,900 holding
intervals, 18,900 published rows across 319 people.** Coverage 44P/45P/48P 100%,
46P 71%, 47P 63%.

**The resolution gate did NOT move, and that is the honest result.** 25.3% →
25.2%. Everything above removes wrong facts; none of it was ever going to add
matches, and §8.13 already set out why the remaining gap is curated aliases and
correctly-unresolvable rows rather than a matching defect. **The §6.1 gate is
still unmet.**

#### Two things that made the numbers move for the wrong reason

- **`--stage extract --force` is not scoped to born-digital documents.** It
  re-ran the deterministic tier over `mixed` documents whose only complete read
  is the VISION artifact, and `loadPendingExtractions` takes the NEWEST
  extraction per document — so the worse read would have won. 85 documents were
  downgraded (deterministic coverage averaging 20.4% against vision's 100%)
  before the repair. **Scope a re-extract by `text_class`, or repair after it by
  deleting the losing artifact and restoring `extract_tier`.** The 14 documents
  that legitimately moved to `partial` are the §2.8 centred-label quarantine
  getting *more* accurate, not a regression.
- **The local Postgres reported `unexpected data beyond EOF`** on relation
  extension, across freshly-created relfilenodes, with 520 GB free. Postgres's
  own hint ("seen to occur with buggy kernels") points at the OrbStack VM
  filesystem, the same environment blocker §8.8 records. Every stored row read
  back cleanly on a full heap scan — it is a WRITE-path fault. `docker restart
  shorted_db` cleared it; `VACUUM FULL` did not. Nothing was lost.

#### Deliberately NOT built, with the evidence

1. **Reverting the fold gate.** `A ⊂ B` was proved, and the 883 withheld
   holdings reproduce exactly (item 1: 391, item 4: 492, 138 politicians).
   Reverting erases **every item-4 directorship for 64 of 161 individuals**, to
   relabel ~14 rows. The quarantine costs 12.
2. **Splitting on `&`** (204 rows, 0 with a corporate suffix before it — would
   shatter `Turnbull & Partners Pty Limited`, `Slater & Gordon Limited`), **on
   bare `and`** (would shatter `Australia and New Zealand Banking Group Ltd`),
   **on unrestricted `:`** (172 of 227 colon rows have a non-label left side),
   or **on `' - '`** (~20 new wrong facts: `"Credit Card - Westpac"`→WBC,
   `"Home Loan ANZ - Boonah"`→ANZ, `"Membership - Brisbane Broncos"`).
3. **n-gram company-name scanning**: 35 vehicle rows, 3 genuine — 91.4% FP
   (`"Port Macquarie Gastroenterology Pty Ltd"`→MQG).
4. **Leading-ticker un-veto**: 92.6% FP. Australian private companies are named
   from principals' initials, which is exactly ASX-code shape.
5. **Holder recovery from leading text.** Reaches at most 147 of 2,518
   `unspecified` rows (5.8%), and every misfire names a **spouse or dependent
   child** as the holder of a shareholding. The honest label carries them
   instead — see below.
6. **A person-name detector.** `"Paula Lindsey"` alone carries no signal
   distinguishing it from a company name. Only the family-relation prefix is
   safe, and `child` is excluded from it because `"Child Psych Corp Pty Ltd"`
   and `"Bald Hills Child Care P/L"` are real declared companies.

#### The holder fault: labelled, not guessed

All 2,518 `holder='unspecified'` rows sit on **alteration** statements (0 of
31,792 base rows), 2,517 of them in 46P/47P, whose alteration form is a
two-column `Item | Details` table with **no holder column** — verified from PDF
word-bboxes. `parse_alteration_page` only consults `holder_of()` for tokens left
of the label boundary, so an inline holder at x≈232 is structurally invisible.

Only 469 of 2,518 contain a holder token at all, and 96 of those name **more than
one holder in one cell**. So `HolderBadge` now renders **"Holder not stated"**
rather than nothing. Rendering nothing put these rows beside rows chipped "Self",
under the member's own name and a heading reading "Declared company interests" —
letting the page imply they were the member's own. The tooltip says *the register
form this was lodged on*, deliberately **not** "the alteration form": 1,021 of
1,022 48P alteration rows ARE attributed, so the general claim would be false.

#### Still open

1. **Sarah Henderson's Santos and John Cobb's Amcor are withheld, not
   recovered.** No safe rule reaches a company NAME inside a vehicle string.
   They are in the curation queue, which is where a human decision belongs.
2. **14 amendment notices still publish in items 2 and 5-14**, which have no
   candidate pipeline. Extending the rule there is **not** safe: in item 10
   (other income) Barnaby Joyce's `"Sale of stock and crops"` is a farmer's
   income SOURCE, not an amendment, and rejecting it would delete a real
   declaration. The same verb means different things by item. The proper fix is
   surfacing `change_type` on the read path, not a wider regex.
3. **Rejecting an amendment withholds a real, past-tense fact.** Rendering it as
   an amendment costs 0 rows but needs a proto field and read-path work.
4. **Item 3 loses real suburbs to the first-comma-part rule** (Canberra, St
   Albans, Palm Beach in the rows above). Withheld, not recovered.
5. **Dependent children are still named** where the form names them — item 8
   `"Savings Account (Poppy Hunt)"`, under a "Dependent child" chip. That is the
   register's own content, but naming a minor adds nothing a reader needs and is
   what editorial §4 exists for. An editorial decision, not a parser one.
6. **Three duplicate politician identities** carry published holdings on mangled
   profiles (`"France. Ms Ali"`, `"Ryan. Ms Joanne"`, `"Doyle Ms Mary"`), all
   with an empty `aph_mpid`. Needs a human merge.
7. **Multi-entity blobs with NO vehicle marker** still publish as one unmatched
   listing (`"BHP (b) Unlisted Companies Centric Wealth Limited"`). They claim
   no false label, but the "not matched" line is untrue of a string naming BHP.
