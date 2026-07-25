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

## 4. Status

| Phase | State |
|---|---|
| 0 — verification spike | **done** (§2) |
| 1 — migration 000096 + `register-discover` | **done** — manifest holds 804 documents (769 house, 35 senate) |
| 2 — `register-fetch` + classify | **done** — streaming content-addressed sink, per-page classification |
| 3 — deterministic parser + golden set | **done** — text tier parses base statements + both alteration variants |
| 4 — `register-load` + identity | **done** — person/term spine, artifacts loaded to normalised rows |
| 5 — security resolution + curated aliases | pending |
| 6 — location resolution → `sal_code` | pending |
| 7 — vision OCR tier | pending |
| 8 — `politicians.proto` + backend API | pending |
| 9 — `/politicians` frontend + 4 integrations | pending |
| 10 — ops wiring + launch gates | pending |

Feature stays dark (`industry_intelligence_sources.public_enabled = FALSE`) until
the QA gates pass **and** an editorial template review against
`docs/influence-editorial-standards.md` rules 1-5 is signed off.
