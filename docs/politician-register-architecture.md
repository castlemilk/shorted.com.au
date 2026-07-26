# Politician Register of Interests — architecture

The influence-layer dataset that ties a named federal parliamentarian to a
listed company (item 1 shareholdings) and to a suburb (item 3 real estate).
Source: the **Register of Members' Interests** (House) and **Register of
Senators' Interests** (Senate), published as PDFs by aph.gov.au.

`ROADMAP.md` Track A / Phase 4. Editorial gate:
[`docs/influence-editorial-standards.md`](./influence-editorial-standards.md).

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
| Dockerfile | `services/influence-collector/Dockerfile` (distroless/static, Go only) |
| CI image build | `terraform-deploy.yml` `build-images` matrix, context `services` |
| Cloud Run Job + scheduler | `terraform/modules/influence-collector/` |
| Env wiring | `terraform/environments/{dev,prod}/main.tf` + `variables.tf` |

Three things that will bite:

- **`CMD ["-mode","all"]` is load-bearing.** This binary's flag default is
  `-mode tax`, unlike economy-collector and house-price-collector which default
  to `all`. An argless run silently ingests ATO corporate tax only and reports
  success. Terraform also sets `args` explicitly; the CMD is the safety net for a
  manual `docker run`.
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
gcloud run jobs execute influence-collector --region australia-southeast2 \
  --args="-mode,register-discover" --wait     # manifest only, no downloads
gcloud run jobs execute influence-collector --region australia-southeast2 \
  --args="-mode,register-fetch,-register-limit,260" --wait
# then the extractor job: --stage classify, then --stage extract
gcloud run jobs execute influence-collector --region australia-southeast2 \
  --args="-mode,register-load" --wait
gcloud run jobs execute influence-collector --region australia-southeast2 \
  --args="-mode,register-resolve" --wait      # also refreshes the MVs
```

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

| Gate | Threshold | Measured | |
|---|---|---|---|
| item-1 security resolution | ≥ 35% of resolvable candidates | **35.3%** (478 / 1,356) | pass |
| identity resolution | 0 unresolved statements | **0** of 2,609 | pass |
| 47P centred-label layout | quarantined, never published | 119 docs at `partial` | pass |
| item-3 multi-property merge | purpose suppressed on read | suppressed (29% of rows merge) | pass |
| no amount/value column | none anywhere in the subsystem | enforced by migration test | pass |
| `analyst_fuzzy` publishable | never | CHECK-enforced, asserted by test | pass |
| freshness sentinel | exit 0 | exit 0 locally; alarm path mutation-tested | pass |
| scan corpus | stated as unread, never as "no declarations" | `CoverageNote` on every profile | pass |

**The scan corpus is the one to argue about.** The 44th and 45th Parliaments
(310 documents) and all 35 Senate volumes are unfetched and unextracted. Without
`CoverageNote` a profile for a member who served then renders an empty list,
which reads as "declared nothing" — an absence claim about a named individual.
That is why the coverage fields are served on `GetPolitician` and stated *above*
the lists rather than as a footnote.

### 6.2 Editorial template review — rules 1-8

Seven rendering surfaces: the four `/politicians` routes, the stock rail card,
the suburb property card, the economy state card. Plus OG images, `<title>`,
descriptions, JSON-LD and alt text.

| Rule | State |
|---|---|
| 1 — citation + as-at on every figure | **enforced by test** — `editorial-copy.test.ts` requires `SourceLine`/`ReportErrorLink` on every rendering surface. Caught `state-politician-holdings.tsx`, which had shipped with neither |
| 2 — juxtaposition, not accusation | manual: no headline pairs a member with a market metric as cause; `/short-interest` renders `disclosure_note` adjacent to the table; no warning-coloured iconography near a person |
| 3 — banned verbs | **enforced by test** |
| 4 — integrity bodies | N/A — no NACC/ICAC data |
| 5 — what is held, never how much | **enforced by test** (no `$`, no currency formatter) + no amount column + proto carries no amount field |
| 6 — right of reply | N/A for automated cards; a standing precondition for any newsroom piece |
| 7 — corrections policy | **closed** — `/disclaimer#corrections` written and linked from `CaveatNote` |
| 8 — report an error | **enforced by test**. Row-level takedown is still whole-feature only — see below |

### 6.3 Open items, stated rather than hidden

1. **Row-level takedown does not exist.** Rule 8's remedy is implementable only
   at whole-feature granularity (`POLITICIAN_INTERESTS_ENABLED=false`). A
   `register_declared_items.suppressed_at` column plus a filter in
   `mv_register_public_holdings` would fix it; until then a single contested
   declaration means taking the whole surface down.
2. **The sitemap and nav are not gated by the kill switch.** With the switch off
   the rpcs return `{}` but the routes still render, the nav entry still shows,
   and `sitemap.ts` still advertises three URLs — so a runtime dark period would
   get empty pages indexed.
3. **The review outcome must be recorded** (who / when / commit). The gate says
   "signed off"; nothing here records a signature.
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
