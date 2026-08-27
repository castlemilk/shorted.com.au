# Data sources

Every source, its licence, and what is ruled out — the audit surface for "may
this appear on a page". Verified against the collector code on **2026-08-09**;
coverage figures are that day's prod measurements.

The governing rule is [README.md](README.md) rule 1: **`source_licence` decides
republishability, and it rides on the row, not on a review comment.** Every fact
table carries it, `mv_housing_headline` bakes the exclusion into SQL (000054),
and every base-table read in `postgres_house_prices.go` re-asserts it.

## IN

| Source | Licence | Gives us |
|---|---|---|
| **ABS Data API** (SDMX-CSV) | CC-BY-4.0 | `RES_DWELL_ST`, `RES_DWELL`, `RPPI`, `LEND_HOUSING`, `WPI`, `CPI` rents + a derived index — 8 of the 16 official jobs |
| **RBA statistical tables** (CSV) | CC-BY-4.0 | E2, F6, F1.1, D1, E1 — debt-to-income, mortgage + cash rates, credit growth, balance sheet (5 jobs) |
| **State Valuer-General** | CC-BY (SA, NSW), CC-BY-4.0 (VIC) | suburb median house prices — SA + VIC only, **NSW/QLD/WA at zero** |
| **ABS Census 2021 GCP SAL DataPack** | CC-BY-4.0 | the suburb spine: population, medians, language, religion, birthplace |
| **ABS ASGS Edition 3 (2021)** shapefiles | CC-BY-4.0 | the committed map boundaries (`web/public/geo/`) |
| **AEC 2025** (tally-room event 31496) + **ABS SED_2025** | CC-BY-4.0 | federal division, member, party, 2PP; state district |
| **State parliament member tables** (Wikipedia) | CC BY-SA — attribute | state member + party; 6 single-member states, TAS/ACT NULL by design |
| **NSW BOCSAR** + **ABS CVS/ERP** | CC-BY / CC-BY-4.0 | suburb crime rates + national percentile ranks (NSW only) |
| **OSM (Overpass)**, ACARA, Geoscience Australia, NBN, IIP | ODbL / ToS / CC-BY / CC-BY-4.0 | local-insights amenity, school, health, connectivity, funding layers |
| **REA / Domain / property.com.au** | `proprietary-tos-restricted` | listings, price-change events, per-address AVM — **never republished raw** |
| **BIS-via-FRED, OECD, ATO, ABS Lending** | open / public domain | the Widow-Maker feature's arrays, BAKED in `series.ts` |

## ABS: the WAF posture is mandatory

`abs.go` sends `User-Agent: shorted-housing/1.0 (+https://shorted.com.au)` and
`Accept: application/vnd.sdmx.data+csv;labels=both`. A bare request **403s** — a
fetch-posture requirement, not politeness, and the same holds for the Census
DataPack and the CVS workbooks. Flow keys (`RES_DWELL_ST` `1+5..Q`, `RES_DWELL`
`3+4..Q`, `RPPI` `1.3.100.Q`, …) are pinned in code, never derived from labels.

**The RPPI is frozen at 2021-Q4 upstream, with no successor dataflow** — hence
`abs_derived_index`, a `RES_DWELL_ST` mean-price rebase to 100 at each region's
earliest quarter, stored as `source='abs_derived'`. It is **not** the ABS
hedonic methodology and must never be presented as the RPPI.

RBA tables are one CSV each at a stable URL (`e2`, `f6`, `f1.1`, `d1`, `e1`),
located by exact **Series ID** — never column position — and blank/withheld
latest cells are skipped, not zero-filled.

## State Valuer-General — the tier that is actually broken

| State | How | Licence | As at 2026-08-26 |
|---|---|---|---|
| SA | `data.sa.gov.au` CKAN datastore, "Metropolitan Median House Sales" (quarterly, dynamic median columns) | CC-BY | LIVE — 426/1,698 suburbs priced |
| VIC | `land.vic.gov.au` "Median House by Suburb" XLSX behind Cloudflare, via `stealthhttp`'s **native** engine (curl gets the challenge page) | CC-BY-4.0 | Pinned to a 2014–2024 workbook, **frozen at Dec-2024** — 766/2,946 |
| NSW | **Bulk Property Sales Information**: yearly zip → 53 weekly zips → ~95 `.DAT` files; we aggregate B-records into suburb medians ourselves | CC-BY (attribute "NSW Valuer-General") | **LIVE — 2,433/4,544 suburbs priced.** The Cloudflare-egress blocker below is resolved |
| QLD, WA, TAS, NT, ACT | — | — | No VG tier exists — 0 suburbs priced |

Measured against the prod API on **2026-08-26** (suburbs with a non-zero median):
NSW 2,433 · VIC 766 · SA 426 · QLD 0 · WA 0 · TAS 0 · NT 0 · ACT 0. NSW landing
is the change since the 2026-08-09 revision, which recorded it at zero.

Still known-open: QLD (0/3,235), WA (0/1,701), TAS (0/778), NT (0/305) and ACT
(0/138) have no Valuer-General tier at all, so those maps fall back to population
colouring — invisible because a failed official job still exits 0
([pipeline.md](pipeline.md)). **These five states are also the reason
`/housing/rankings` publishes NSW/VIC/SA only** (see
`web/src/@/lib/housing-rankings/registry.ts`): every ranking metric needs a
median price, so an unpriced state could only produce an empty page. Landing a
VG tier for any of them enables five ranking pages for a one-line registry edit —
the copy is already written.

## ABS Census 2021 — what `-mode census` does not take

Entries parsed: **G01** (population, birthplace, English-only), **G02** (five
medians), **G13A–E** (language at home), **G14** (religion). Inputs are
`CENSUS_DATAPACK_PATH` + `CENSUS_GEO_DIR` — the boundary TopoJSON is the
authoritative `sal_code` registry, so a suburb with no boundary gets no row.

**Tenure is not ingested.** `pct_owned_*` / `pct_rented` / `dwelling_count`
exist as columns (000055) but G33/G37 are unparsed, so they are reserved NULLs.
Don't build a metric on them.

## Electoral

Boundaries and results are joined **once, offline** in `web/scripts/geo/`
(centroid point-in-polygon); the output is committed as four files under
`web/public/geo/electorates/` which the collector merely loads — no GIS at
ingest. Members and 2PP come from AEC tally-room **event 31496**.

**TAS and ACT have NULL state members by design** — both are Hare-Clark
multi-member, so there is no single member for a district. NULL is the honest
value, not a gap to close.

Refresh landmines, each of which has bitten: AEC boundary vs results-CSV casing
(`O'connor` vs `O'Connor`) — match case-insensitively, keep the CSV name, or
~950 suburbs drop; ABS SED names carry a `District (Region)` qualifier
`join-sed.mjs` strips; `fetch-state-members.py` substring-matches surnames
unless party matching is restricted to full names, `LNP`/`CLP`/`ON` exact-only.

## Crime — NSW only, and gated twice

NSW BOCSAR "Recorded Criminal Incidents by suburb" (`SuburbData.zip`) supplies
incidents; the **ABS Crime Victimisation Survey** is the cross-jurisdiction
scaling anchor (*prevalence*, not incidence — the crosswalk documents the
adjustment); ABS **ERP** is the per-FY denominator and the rank's weight.

Gating is doubled: `mv_suburb_crime_latest` (000092) serves only `pooled AND
pct_rank IS NOT NULL AND NOT small_pop AND NOT unreliable AND source_licence <>
'wa-tou-noncommercial'`, and the read path re-asserts it (`small_pop` = ERP <
2000, `unreliable` = state CVS anchor RSE > 25%). Rank 0 renders as a no-data
hatch — the map never paints a zero it did not measure.

## The crawl tiers

REA (Kasada) and Domain (Akamai) search pages feed `property_listings` /
`property_price_events`; the older median sweep writes `crawl_rea` /
`crawl_domain` rows into `house_prices`; property.com.au — REA Group's
per-address AVM portal, whose robots.txt explicitly bans aggregators — feeds
`property_valuations`. All of it is `proprietary-tos-restricted`, a column
DEFAULT, so the unlicensed state is unstorable. Corpus as at 2026-08-09:
88,689 listings across 500 suburbs.

Four rules, none negotiable:

1. **Never republished raw** — only derived aggregates are a publishable surface.
2. **Counts-only crosses to brandbrain**; listings, prices and addresses are
   written to the shorted DB and nowhere else.
3. **`CRAWL_TRACE` artifacts stay local** — screenshots and page HTML are portal
   content; `/traces/` and `*.png` are gitignored, never uploaded.
4. **A block is a signal, not an obstacle.** REA serves deliberately false data
   to clients it suspects, which is why nothing persists without passing the
   validation gates ([architecture.md](architecture.md)).

Known-open, fixes in flight: `GetPropertyHistory` serves per-address AVM
estimates + sales history publicly, contradicting 000088's own "raw profile is
internal enrichment only" posture (*api-hardening*); and four committed
`testdata` files hold real portal markup in a public repo (*repo-hygiene*).

## Derived, not sourced

**Suburb banners** are a classification, not a feed: a deterministic classifier
over local-insights signals produces the committed `suburb-archetypes.json`
(**15,329 SALs**), which `-mode banners` upserts. No crawl, no LLM at ingest.

**The feature arrays** (`features/housing/data/series.ts`, **27-source**
bibliography in `sources.ts`) are transcribed once — BIS real HPI via FRED
(AUS/JPN/USA/CHN), OECD price-to-income, ABS Lending investor share, ATO
negatively-geared landlords. Never fetched at runtime, **not in the DB**.

**Local-insights gates:** raw OSM points are never stored — only derived counts
and 0–100 scores, so we hold a Produced Work, not an ODbL share-alike database.
ACARA's list carries "Source: ACARA" under the My School terms; NBN footprints
are area-level only; `lga` financial columns are per-state licence-gated (VIC
CC-BY-4.0 and ingested, NSW "Your Council" Crown copyright and NULL).

## OUT — settled, not deferred

- **Publishing any raw crawl row.** That it never reaches a public surface raw is
  the entire justification for holding it; widening that removes the tier's only
  defence.
- **Per-address AVM as a public surface.** Settled by 000088 at table-creation:
  internal enrichment only. The read path contradicts it — the resolution is to
  gate the read path, not to reopen the question.
- **Residential or mobile proxies to scale the crawl.** Measured 2026-07-22: the
  block ceiling is **fingerprint-scoped, not per-IP** — the warm native-Chrome
  session clears Kasada, so a proxy alone buys nothing. Priced ($2.50–8/GB
  residential, ~$240–435/mo for three AU 4G ports) and declined in favour of
  right-sizing demand.
- **Uploading `CRAWL_TRACE` artifacts** anywhere — bucket, issue or PR.
  Local-only is the whole mitigation.
- **WA crime data.** Non-commercial terms (`wa-tou-noncommercial`), excluded at
  the SQL level. This is a paid product, so NC is fatal, not inconvenient.
- **NSW council financials.** Crown copyright, no reuse grant — the columns stay
  NULL rather than carry a number we cannot publish.
- **School performance data from ACARA / My School (NAPLAN, ICSEA), and any
  school ranking or league table built from it.** Checked against the My School
  terms of use on **2026-08-27**; this is the most restrictive source we have
  assessed, and it fails on three independent grounds:
  - **No open licence at all.** ACARA asserts copyright over everything on the
    site. There is no CC-BY equivalent, unlike every other source in the IN
    table.
  - **Clause 7.1(b) prohibits exactly this feature**: creating "lists of
    comparative school performance from such content, or anything derived from
    such content, for a commercial purpose". Shorted is a paid product, so a
    school ranking is the prohibited use named in the terms.
  - **Clause 6.4 bars republishing on a publicly accessible website even for
    permitted non-commercial educational use**, so there is no reduced-scope
    version of this that works either.

  Clause 7.1(c) separately forbids using the content to compete with My School
  as a source of NAPLAN data. Beyond the licence, school league tables are the
  subject of a live public objection from every education peak body — a
  reputational cost on top of a legal one, for a feature peripheral to the
  product. **The licensable substitute is ABS SEIFA** (CC-BY, published at SAL
  geography, four indexes including Education and Occupation), which is what
  ICSEA is itself derived from and carries no such restriction.
