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
| **DEA Water Observations Statistics** (Geoscience Australia, Landsat multi-year frequency `ga_ls_wo_fq_myear_3` v2.1.0, 1987–) | CC-BY-4.0 | per-suburb share of land observed under water at least occasionally, and permanent water; the national `water_observed` map overlay. 1,037 COG tiles, 17 GB, anonymous S3 |
| **NSW EPI Flood** (NSW Planning Portal, `Planning/Hazard` layer 1) + **EPI Land Application** (`EPI_Primary_Planning_Layers` layer 6, coverage mask) + **NSW Bush Fire Prone Land** (NSW RFS) | CC-BY / CC-BY-4.0 | NSW `flood_planning` / `bushfire_prone` shares and overlays. Flood is NULL outside the 12 instruments that lodged a map. Councils own flood currency since July 2021 — the caveat ships with the layer |
| **Vicmap Planning overlays** LSIO / FO / SBO (DTP Victoria, WFS `open-data-platform:plan_overlay`, gazetted status only) | CC-BY-4.0 | VIC `flood_planning` share and overlay |
| **VIC Designated Bushfire Prone Area** (Building Regulations, WFS `open-data-platform:bushfire_prone_area`) | CC-BY-4.0 | VIC `bushfire_prone` share and overlay (replaced the narrower BMO planning overlay, 2026-09) |
| **SA Planning and Design Code overlays** (PlanSA bulk shapefile `PDCodeOverlays_shp.zip`) | CC-BY-3.0-AU | SA `flood_planning` (Hazards (Flooding) + (Flooding – General)) / `bushfire_prone` (Hazards (Bushfire) High/Medium/General/Urban Interface); the precautionary overlays are the unassessed mask |
| **Tasmanian Planning Scheme Code Overlay** (theLIST `PlanningOnline` layer 14) + LGA boundaries (layer 8, coverage mask) | CC-BY-3.0-AU | TAS `flood_planning` (Flood-prone Areas) / `bushfire_prone` (Bushfire-prone Areas) |
| **QLD Bushfire Prone Area** (Queensland Fire Department, `Hosted/BPA` feature service) | CC-BY-4.0 | QLD `bushfire_prone` share and overlay |
| **WA Bush Fire Prone Areas OBRM-026** (DFES / OBRM, SLIP `Bush_Fire_Prone_Areas` layer 23) | CC-BY-4.0 | WA `bushfire_prone` share and overlay |
| **ACT Bushfire Prone Area 2026** (Overview) + **ACT Flood Extent Model 1% AEP** (ACTmapi) | CC-BY-4.0 | ACT `bushfire_prone` and `flood_planning` (the latter a modelled extent, labelled as such) |
| **Statewide planning zones** — NSW EPI Land Zoning (NSW Planning Portal, `Principal_Planning_Layers/MapServer/11`); Vicmap Planning `plan_zone` (gazetted); SA Planning and Design Code Zones (PlanSA zip); Tasmanian Planning Scheme zones (theLIST `PlanningOnline/13`) + Kingborough Interim Planning Scheme 2015 (`PlanningOnline/4`); ACT Territory Plan Land Use Zones (ACTmapi) | CC-BY (NSW) / CC-BY-4.0 (VIC, ACT) / CC-BY-3.0-AU (SA, TAS) | `suburb_planning` zoning-family shares, dominant family, instrument names; the categorical `zoning` overlay. See "Planning layer" below |
| **Heritage areas + listings** — NSW EPI Heritage; Vicmap Heritage Overlay (`plan_overlay` HO, gazetted); SA Code heritage/character overlays; TAS TPS Local Historic Heritage Code; ACT Heritage Register (filtered); Queensland Heritage Register boundaries | CC-BY / CC-BY-4.0 / CC-BY-3.0-AU (SA, TAS) | `heritage_share_pct`, `heritage_item_count`; the `heritage` overlay |
| **NSW development standards** — EPI Height of Buildings (`/7`), Floor Space Ratio (`/4`), Minimum Lot Size (`/14`) + their clause-application layers (NSW Planning Portal) | CC-BY | `nsw_height_median_m`, `nsw_height_max_m`, `nsw_fsr_median`, `nsw_min_lot_median_m2` + their `nsw_*_mapped_pct`; credited on the card and the page's sources line as `nsw_epi_development_standards` |
| **OSM (Overpass)**, ACARA, Geoscience Australia, NBN, IIP | ODbL / ToS / CC-BY / CC-BY-4.0 | local-insights amenity, school, health, connectivity, funding layers |
| **ABS ASGS Ed.3 allocation files** (`SAL_2021_AUST.xlsx`, `LGA_2024_AUST.xlsx`) + **Census 2021 Mesh Block Counts** | CC-BY-4.0 | the suburb→council bridge: dominant council, its share, every council ≥ 1% (`join-lga-mb.py` → `suburb-lga.json`); council identity, dwellings, centroid (`lga-facts.json`). Raw files staged off-git |
| **ABS ERP by LGA** (`ERP_LGA<Y>`, `ERP_COMP_LGA<Y>`; one flow per release, newest discovered each run) | CC-BY-4.0 | `lga.population` (ERP at 30 June), `erp_year`, `pop_growth_pct`; `lga_series` erp + natural increase, net internal / overseas migration |
| **ABS Census 2021 by LGA** (`C21_G02_LGA`, `C21_G37_LGA`) + **SEIFA 2021 by LGA** (`ABS_SEIFA2021_LGA`) | CC-BY-4.0 | `lga` median age / household income / rent / mortgage, household size, % renting, IRSAD + IRSD national deciles |
| **ABS Data by Region** (`ABS_REGIONAL_LGA2021` v1.6.0: `HOUSES_2..5`, `BUILDING_4`) | CC-BY-4.0 | `lga_series` **council-level** median established-house and attached-dwelling transfer prices + counts, FY dwelling approvals. A council's median, **never a suburb's** — see below |
| **ABS Building Approvals by LGA** (`BA_LGA<FY>`, monthly, key-filtered `1.9.TOT.100+110+850...M`) | CC-BY-4.0 | `lga_series` monthly dwelling units approved: total, houses, other |
| **Federal Financial Assistance Grants** (Dept of Infrastructure, `fa-grants-historical-2017-18-to-2025-26.xlsx`) | CC-BY-4.0 | `lga_series` `fag_total_aud` 2017-18..2025-26; latest year on `lga.fed_fag_*` |
| **VIC LGPRF** Full Council Data Set (Local Government Victoria; URL read from the data.vic CKAN record `local-government-performance-reporting`, `license_id=cc-by`) | CC-BY-4.0 | `lga` avg rates, operating result, asset renewal — VIC only |
| **Wikidata** (SPARQL, `P10112` ASGS LGA code → QID, `P856` official website) | CC0-1.0 | `lga.wikidata_qid`, `lga.website`, from the committed snapshot `services/house-price-collector/data/wikidata-lga.json`. Identity only: no Wikipedia prose, no Wikidata coordinates (centroids are computed from ABS geometry) |
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
CC-BY-4.0 and ingested, NSW "Your Council" Crown copyright and NULL). Council
sources are listed in the IN table and under "Councils" below.

## Councils: council-level figures stay council-level

Everything in `lga` and `lga_series` describes a **whole council**. The ABS
Data by Region house medians (`house_median_price`, `attached_median_price`)
cover 501 councils — including QLD, WA, TAS and NT, where we have no
Valuer-General suburb feed — and that is exactly why they are dangerous: one
number for Brisbane City sitting under a Brisbane suburb reads as that suburb's
price. So they are shown **only** as "council-wide house median (FY)", with the
financial year, on the council card; they are **never** written to
`house_prices`/`house_price_regions` and never spread across member suburbs.
They are ABS medians of established-house *transfers* in the year ended 30 June,
not Valuer-General sale records.

Council identity joins on **ABS code**, never on names — except the two
name-matched sources, FAG and VIC LGPRF, which match on `(state,
normCouncil(name))` and report what they cannot match. Code vintages:
LGA_2021 Moreland `25250` = LGA_2024 Merri-bek `24700`; LGA_2025 East Arnhem
`71500` + Groote Archipelago `71700` = LGA_2024 East Arnhem `71300` (summed for
people and approvals, dropped for medians).

Not sourced, deliberately: mayors and councillor counts (no national open
source; `mayor`, `councillor_count`, `aclg_group` stay NULL), council logos
(each council's copyright), and NSW OLG "Your Council" (Crown copyright).

## Hazard layers — what the words mean

Every hazard number is an **area share** computed in GDA2020 Australian Albers
against the committed SAL boundary, with the source named on the row. Three
rules, each of which is a wording rule as much as a data rule:

- **"Observed under water", never "flood risk".** The satellite share is a record
  of water that was SEEN. Landsat revisits every 8–16 days and cloud hides
  events, so it under-observes flood peaks — a floor on inundation, not a
  ceiling, and never a probability. Permanent water (≥90% of clear passes:
  lakes, rivers, the sea) is a separate share so the coast is not painted as
  flooding. The frequency is masked with **DEA's WOfS confidence layer**
  (filtered summary v2.1.0, cutoff 0.1; cells below it count as dry land, not as
  missing) because the classifier reads tower shadow as water: unmasked, the
  Sydney CBD came out at 44% "observed", Canberra City at 8%. Masked, Canberra
  City is 0.6% — but the Sydney CBD stays near 23%, and DEA's own published
  filtered product agrees (~21% of its retained cells are in the 5–90% band),
  so it is a limitation of the source, stated in the layer's caveat, not a
  defect to tune away.
- **Statutory layers are planning-control boundaries, not flood extents.** NSW's
  EPI Flood layer is whatever councils have lodged (614 polygons statewide, with
  a comment field warning it may lag the latest study); VIC's LSIO/FO/SBO,
  SA's Code overlays and TAS's code overlays are planning-scheme overlays. The
  instrument is named on the card and in the overlay picker. **The one
  exception is ACT flood**: the ACT publishes no open flood planning overlay,
  only its modelled 1% AEP flood extent, so there — and only there — the layer
  is described as a model of one flood event, never as a planning control
  (`stateCaveats.ACT` in `overlays.ts` replaces the generic caveat).
- **Bushfire layers are designations, and they must be the same kind of
  designation.** NSW Bush Fire Prone Land, VIC's Designated Bushfire Prone Area,
  QLD's Bushfire Prone Area, WA's OBRM-026 and ACT's Bushfire Prone Area are all
  the broad "prone" designation that triggers building controls. VIC used to be
  the narrower Bushfire Management Overlay, which made a VIC share incomparable
  with a NSW one; it is the BPA since 2026-09 (`bushfire_source = 'vic_bpa'`).
  SA and TAS are planning-code overlays of the same intent. QLD's includes the
  potential-impact buffer, and its regional vintages differ (SEQ 2017,
  elsewhere 2014) — both stated in the layer note.
- **No source is not zero — per state AND per suburb.** NT has no open statutory
  flood or bushfire layer we can republish, and QLD and WA have no open flood
  layer, so those shares are NULL and the overlay picker lists the layer greyed
  with the reason. Inside a state that has a layer, a suburb the source's
  instruments do not reach is NULL too, never 0 (`vector_share.py
  --coverage-dir` / `--unassessed-dir` / `--coverage-hull`):

  | State / layer | Covered | NULL (no statutory layer here) |
  |---|---|---|
  | NSW flood | land under one of the 12 instruments in the EPI Flood layer (10 LEPs + 2 precinct SEPPs), via their EPI Land Application boundaries | everywhere else — those councils keep flood maps in a DCP. Before the mask 4,350 suburbs, Lismore and Windsor among them, showed a measured 0% |
  | SA flood | the Code's mapped Hazards (Flooding) (high/extreme risk, >300 mm in the 1% AEP event) and (Flooding – General) (the low/medium-risk rest of the mapped 1% AEP extent) — both, because NSW and VIC flood planning areas cover the whole 1% AEP extent and "Hazards (Flooding)" alone would repeat the VIC-BMO comparability error. The River Murray Flood Plain and Coastal Flooding overlays are separate instruments and not included | land under the precautionary **Hazards (Flooding – Evidence Required)** overlay, which the Code applies "where flood risk is unknown" pending studies |
  | SA bushfire | High / Medium / General / Urban Interface overlays | land under the precautionary **Regional** and **Outback** overlays, applied where no vegetation mapping exists |
  | TAS flood | the 21 councils whose Local Provisions Schedule maps Flood-prone Areas | the other 7 councils (no LPS flood map) and Kingborough (interim scheme) |
  | TAS bushfire | the 28 councils on the Tasmanian Planning Scheme (every LPS maps the overlay, so land outside it is not bushfire-prone under C13.3.1(a)) | Kingborough, still on its interim scheme |
  | ACT flood | the convex hull of the modelled extent (the urban catchments) | the rural districts and new suburbs outside the model |
  | VIC, QLD, WA, ACT bushfire; VIC flood | statewide designations — a zero is a real zero | — |

  A suburb less than **50%** covered is NULL. A partly covered one publishes
  the mapped hazard land inside its covered part divided by the **whole**
  suburb — a floor, and what every surface says it is ("the proportion of the
  suburb's land area"); the card adds that it is a floor in the masked states
  (`OverlayDef.masked`). The first cut divided by the covered land at a 10%
  floor, which extrapolated the covered part over land nobody mapped and, where
  the mask is not independent of the hazard, was wrong by construction: in SA
  councils such as Tea Tree Gully the Code maps the creek corridor as Hazards
  (Flooding) and every other parcel as Evidence Required, so the covered land
  *was* the flood land and Dernancourt (10.7% flood, 89.3% Evidence Required)
  and Surrey Downs published 100%. Measured on that cut: 40 SA suburbs at ≥90%
  flood from under half coverage, and Middleton and Lower Longley (Kingborough,
  10.8% and 20.6% covered) at 100% bushfire. The map hatches NULL as "No
  statutory layer"; the profile card says "Not mapped" with the reason
  (`OverlayDef.uncovered`), never 0%.
- **A NULL statutory share still names its instrument.** `flood_source` /
  `bushfire_source` are set whenever the state has a layer, share or no share,
  so "the instrument does not cover this suburb" (source set, share NULL) is
  distinguishable from "the state has no layer, or this row predates it"
  (source empty). The card shows its "Not mapped: <reason>" tile only on the
  first, so a web deploy ahead of a `-mode hazards` load never tells an
  unloaded SA/TAS/ACT suburb it is Evidence Required.
- **Attribution carries the licence per source.** SA's Code overlays and TAS's
  theLIST layers are CC BY 3.0 AU, everything else CC BY 4.0;
  `STATUTORY_HAZARD_CREDITS` in `suburb-profile.tsx` credits each under its own,
  and `suburb_hazard_exposure.source_licence` records `CC-BY-4.0; CC-BY-3.0-AU`
  on rows that carry an SA or TAS layer.

Fetched 2026-09-23 (SA bulk file modified 2026-08-18; NSW and VIC flood layers
2026-09-08):

| Source id | Endpoint | Filter |
|---|---|---|
| `nsw_epi_flood` | `mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Hazard/MapServer/1` | `LAY_CLASS IN ('Flood Planning Area','Flood Prone and Major Creeks Land','1 in 100 AEP Flood Extent')`; mask `EPI_Primary_Planning_Layers/MapServer/6` for the same 12 `EPI_NAME`s |
| `vic_plan_overlay_lsio_fo_sbo` | `opendata.maps.vic.gov.au/geoserver/wfs` `plan_overlay` | `zone_code` LSIO/FO/SBO, `zone_status='g'` |
| `vic_bpa` | same WFS, `open-data-platform:bushfire_prone_area` | all 76 |
| `sa_pdcode_hazards_flooding` / `_bushfire` | `dptiapps.com.au/dataportal/PDCodeOverlays_shp.zip` (data.sa.gov.au "Planning and Design Code overlays") | `name` as above; staged with `extract_layer.py` |
| `tas_tps_flood_prone` / `tas_tps_bushfire_prone` | `services.thelist.tas.gov.au/…/PlanningOnline/MapServer/14` | `CODE='Flood-prone Hazard Areas Code'` / `'Bushfire-prone Areas Code'`; mask layer 8 |
| `qld_qfd_bpa` | `utility.arcgis.com/usrsvcs/servers/3ec80e95fa084ef9901205df0a7a74ec/rest/services/Hosted/BPA/FeatureServer/0` | all 2,556,671 (range-paged on `fid`) |
| `wa_obrm_026_bpa` | `public-services.slip.wa.gov.au/…/Bush_Fire_Prone_Areas/MapServer/23` | all 148 |
| `act_bpa_2026` | `services1.arcgis.com/E5n4f1VY84i0xSjy/…/Bushfire_Prone_Area_Overview_2026/FeatureServer/0` | all 21 |
| `act_flood_extent_1pct_aep` | `services1.arcgis.com/E5n4f1VY84i0xSjy/…/ACTGOV_FLOOD_EXTENT/FeatureServer/0` | the one dissolved extent |

Ruled out for this layer (recorded so it is not re-proposed): the insurer-only
NFID; QLD's `FloodCheck/BasinOnePercentAEP` service (raster map-index
footprints, not flood extents, behind a token) and the 2013 QFAO (an interim
product that says it is not for parcels — deferred, not refused); WA DWER
floodplain mapping (an active-acceptance licence, not CC-BY); per-council flood
studies (hundreds of portals with no common schema); every commercial
flood-risk score.

## Planning layer — zoning, heritage, NSW development standards

Fetched 2026-09-23 (UA `shorted-housing/1.0 (+https://shorted.com.au)`, resumable
NDJSON pages with `.done` markers) to `/Volumes/gamma-systems-2/shorted-planning/
vector/<layer>/`; `manifest.json` there records per layer the source URL,
licence, counts, fields and every distinct code. Raw geometry is never
committed — only the derived artifact and the simplified overlays.

| Layer | Source URL | Licence | Features |
|---|---|---|---|
| `nsw-zoning` | `mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Principal_Planning_Layers/MapServer/11` (data.nsw `environment-planning-instrument-local-environmental-plan-land-zoning`) | CC BY (data.nsw `cc-by`) | 70,511 |
| `nsw-heritage` | `…/Principal_Planning_Layers/MapServer/8` (data.nsw `environmental-planning-instrument-heritage-her`) | CC BY | 40,340 |
| `nsw-hob` / `nsw-fsr` / `nsw-lotsize` (+ `*-additional`) | `…/MapServer/7`, `/4`, `/14` (+ `/6`, `/3`, `/13` clause areas) | CC BY | 40,978 / 34,844 / 41,667 (+548 / 5,591 / 980) |
| `nsw-landapp` | `…/MapServer/1` (LEP land application) | CC BY | 203 |
| `vic-zoning` | `opendata.maps.vic.gov.au/geoserver/wfs` `open-data-platform:plan_zone`, `zone_status='g'` | CC BY 4.0 | 51,247 |
| `vic-heritage` | same WFS, `plan_overlay` `zone_code LIKE 'HO%'`, gazetted | CC BY 4.0 | 25,048 |
| `sa-zones` / `sa-overlays` | `dptiapps.com.au/dataportal/PDCodeZones_geojson.zip` / `PDCodeOverlays_shp.zip` (heritage + character classes only) | CC BY 3.0 AU (License.txt in the zip; data.sa lists CC BY 4.0 — we record the one that shipped with the bytes) | 5,402 / 16,591 |
| `tas-zones` (+ `tas-zones-kingborough-interim`) | `services.thelist.tas.gov.au/arcgis/rest/services/Public/PlanningOnline/MapServer/13` (+ `/4`) | CC BY 3.0 AU (theLIST CSW `gmd:useLimitation`) | 12,774 (+743) |
| `tas-heritage` | `…/PlanningOnline/MapServer/14`, `CODE='Local Historical Heritage Code'` | CC BY 3.0 AU | 4,675 |
| `act-zones` | `services1.arcgis.com/E5n4f1VY84i0xSjy/…/ACTGOV_TP_LAND_USE_ZONE/FeatureServer/1` | CC BY 4.0 (ACT) | 5,911 |
| `act-heritage` | `…/ACTGOV_Heritage_Register/FeatureServer/1`, filtered server-side | CC BY 4.0 (ACT) | 2,601 of 7,470 |
| `qld-heritage` | `spatial-gis.information.qld.gov.au/…/AdminBoundariesFramework/FeatureServer/78` | CC BY 4.0 | 1,798 |

**Zoning families.** Every state's zones map onto ten harmonised families
(program decision 8): `res_low`, `res_medium_high`, `centre_mixed`,
`industrial`, `rural`, `conservation`, `open_space`, `infrastructure`, `water`,
`other`. The maps live in `web/scripts/geo/planning/zone_families.py`, and an
unknown code **fails the build** — it never falls silently into `other`. Choices
worth knowing before you read a number:

- NSW is keyed by code **and** class, because codes are reused: E2 is Commercial
  Centre after the 2023 employment-zone reform but Environmental Conservation in
  the pre-reform LEPs still carrying it (likewise E4). SP1–SP3 are
  infrastructure; **SP5 Metropolitan Centre (the Sydney CBD) is `centre_mixed`
  and SP4 Enterprise is `industrial`** — mapping by the SP prefix painted the CBD
  as infrastructure. RU5 Village stays `rural` (the Standard Instrument groups it
  there). DM Deferred Matter and UL Unzoned Land are `other`.
- VIC: NRZ/LDRZ/TZ `res_low`; GRZ/RGZ/HCTZ `res_medium_high`; ACZ/C1Z/C2Z/MUZ/CCZ/
  DZ/PRZ `centre_mixed`; RCZ `conservation`; SUZ/PUZ/TRZ/PZ `infrastructure`; UFZ
  `water`. **UGZ, CDZ, PDZ and CA are `other`**: an Urban Growth Zone's uses come
  from a later Precinct Structure Plan, CDZ/PDZ are site-specific schedules, and
  CA is Commonwealth land outside the scheme.
- SA Code "Neighbourhood" zones split by intensity (Established/Suburban/Hills →
  `res_low`; General/Housing Diversity/Urban → `res_medium_high`); Deferred Urban
  is `other`. TAS: Kingborough's interim scheme is mapped with the same table.
  ACT: DES (Designated, planned by the NCA) is `other`; NUZ3–5 `conservation`.

Overlaps between instruments (a NSW SEPP precinct zoning land its LEP also maps,
usually as Deferred Matter) resolve by precedence — SEPP over LEP — so the
family shares **sum to `zoning_coverage_pct`**, never past it.

**Heritage: which classes count.** `heritage_share_pct` is the union of the
AREA classes; `heritage_item_count` counts distinct listed ITEMS, each once, in
the suburb holding its largest polygon. Locations are never listed.

| State | Area classes (share) | Item classes (count) | Excluded |
|---|---|---|---|
| NSW | Conservation Area – General / Landscape / Archaeological; Heritage Conservation Area | Item – General / Landscape / Archaeological; Local Heritage – General (distinct `EPI_NAME`+`H_ID`) | every Aboriginal class (cultural sensitivity) |
| VIC | every gazetted Heritage Overlay polygon (the HO does not separate precincts from places) | — (NULL: the VHR was not fetched and HO numbers mix both) | Heritage Inventory (archaeological sites) |
| SA | Historic Area, Character Area, State Heritage Area | Local Heritage Place, State Heritage Place (distinct `value`) | Heritage Adjacency (a buffer, not a listing); Character Preservation District (Barossa/McLaren Vale landscape Acts) |
| TAS | Local heritage precinct, Local historic landscape precinct | Local heritage place (distinct `LPS`+`OV_CAT` where the LPS fills `OV_CAT` — Devonport and six Southern Midlands places; every other LPS leaves it blank, so each polygon is one place, which overcounts a place drawn in pieces and cannot be detected) | Significant trees; archaeological-potential places. **Mapped council by council** (18 of 28 LPS): a value is only measured where the suburb's governing LPS maps that class, else NULL |
| ACT | registered Historic places (register boundary) | the same places (distinct `HeritageID`) | natural places; restricted rows and Aboriginal places are filtered at fetch |
| QLD | — (the register is places, not areas) | Queensland Heritage Register places | — |

**Item counts are not like-for-like across states.** QLD counts only the
Queensland Heritage Register (State-listed places); NSW, SA and TAS count local
planning-scheme listings (SA adds State places); ACT counts its register. Paddington
QLD shows 15, Paddington NSW 103. The card's tile names the list per source and
the footnote says the counts do not compare across states.

**Coverage gate (both the zoning families and heritage).** `zoning_coverage_pct`
is always the measured share of the suburb the scheme layer maps. Below **50%**
it is the only planning value written: the rest of the suburb is planned by an
instrument these layers do not carry, so a heritage share would count that land
as "no heritage" and a dominant family would come from a sliver (The Rocks:
2.9% in the Sydney LEP, previously 0% heritage and 0 listed places; Broken Hill:
1.3%). 15 suburbs, 14 NSW + 1 VIC, as at 2026-09-24. The card says the map
covers only X% and gives no mix or heritage. Enforced in `planning_share.py`
(`MIN_MEASURED_COVERAGE_PCT`), in the collector's `validate()` and by migration
000125's `suburb_planning_measured_check`.

**NSW development standards** are area-weighted over the suburb's
residential-zoned land (`res_low` + `res_medium_high`): median and maximum
Height of Buildings (RL heights — an elevation above datum, not a height — are
dropped), median FSR, median minimum lot size (hectares normalised to m²). The
`*-additional` layers are clause-application areas (`CA`, street frontage)
that carry no number bar four HOB polygons; the mapped base standard still
applies beneath them, so the base layer supplies the numbers and those four
override it where they lie. Clause-based exceptions are not modelled, and the
card says so.

**A standard is reported only where it is mapped on at least half the
residential land.** Many LEPs map FSR, and some map height, only in their
centres or precincts, so a median over the mapped part alone is the centre's
number. Castle Hill's FSR was mapped on 4.9% of its residential land and stored
as 1.6:1; Wagga Wagga's height was mapped on 4.5% and stored as 16 m, "up to
25 m". Each standard now stores `nsw_*_mapped_pct` (the share of residential land
it is mapped on, where 0 is a measured nowhere), and the median/max only when
that is ≥ 50%. As at 2026-09-24, of 2,099 suburbs with residential land, FSR
is mapped on under half for 1,488, height for 746 and lot size for 195. So 611
suburbs have an FSR, 1,353 a height and 1,904 a lot size (previously 856 /
1,463 / 2,043). The card names a withheld standard and its mapped share. Below
95% it prints "mapped on X% of residential land" under the value. Enforced in the
same three places (`CONTROL_MIN_MAPPED_PCT`).

**NSW licence is recorded as published: `CC-BY`, unversioned.** data.nsw lists
every EPI layer as `license_id 'cc-by'` with the unversioned
`opendefinition.org/licenses/cc-by` URL. No version is stated, so none is
claimed: rows carry `source_licence = 'CC-BY'`, the NSW overlays are stamped
`CC-BY` and the credits read "CC BY".

**Ruled out** (recorded so it is not re-proposed):
- **WA zoning, R-Codes, region schemes, scheme boundaries and heritage** — DPLH
  "Custom (Active Acceptance)": internal business or personal use only, no
  external display. Derived shares are a display of the information. WA stays
  NULL; the overlay picker says why.
- **QLD statewide zoning** — none exists (77 council schemes). Brisbane, Gold
  Coast and Sunshine Coast publish CC-BY zoning, but a three-council patchwork is
  not a state layer. QLD gets heritage item counts only.
- **NT zoning** — no open vector layer (NR Maps is WMS-only; the NT Atlas is
  legacy ArcIMS). NULL.
- **VIC `planning_scheme_boundary`** — no open licence found (its metadata record
  403s); `plan_zone` carries the scheme's LGA on every polygon instead.
- **Tasmanian Heritage Register** — "Other Licence", internal use, ~10% complete.

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

## QLD and WA suburb prices — what is actually available (checked 2026-08-29)

Both states are at zero priced suburbs (QLD 0/3,235, WA 0/1,701) and stay there.
This section exists so the question is not re-opened from scratch: every open
dataset was enumerated and checked, not inferred from the word "blocked".

**Sold prices are licensed in both states.**

| State | Product | Access |
|---|---|---|
| QLD | Queensland Valuation and Sales System (QVAS) | broker or business-centre purchase |
| WA | Landgate Sales Evidence | licence-fee extract, © WA Land Information Authority |

**Every QLD open dataset was checked, and none carries a value:**

| Dataset | Licence | What it actually contains |
|---|---|---|
| `historical-trends-in-land-valuations` | CC-BY-3.0 | LGA-level **percentage change** in statutory value, and sparse — QLD revalues only a subset of LGAs each year, so most cells are `NV`. Not values, and 62 LGAs against 3,235 suburbs |
| `valuation-property-boundaries-queensland` | CC-BY-4.0 | **Geometry only.** Property polygons carrying a `propertyid` that links *into* QVAS — built to be joined to licensed data, not to replace it |
| `annual-property-valuation-objections` | CC-BY-4.0 | Objections lodged, not valuations |

**Do not ship the LGA percentage-change layer as a price proxy.** One number
smeared across every suburb in Brisbane LGA, sitting next to "median house
price" in the same metric picker, reads as a per-suburb figure. The honest gap
is better than a plausible wrong number — the same reasoning that keeps a
suppressed Census rate NULL rather than zero.

**Crawling agent or portal sites does not solve this and is not a shortcut.**
Those sites publish ASKING prices, which the REA/Domain crawl tier already
collects. Valuer-General data is SOLD prices. More asking-price scraping yields
a lower-quality copy of data already held, while putting proprietary
ToS-restricted content into the estate that `source_licence` exists to keep out.
(The hiQ v. LinkedIn case is often cited as licence to ignore this. It is US
CFAA law, and on remand in 2022 hiQ was found to have breached LinkedIn's user
agreement and was enjoined — it lost on contract.)

**If the licensed data is ever bought, the spatial half is already free.** The
CC-BY boundaries layer and its `propertyid` join key cost nothing, so the
purchase would cover values only.

**Meanwhile QLD and WA maps are not blank** — Census, SEIFA, elevation,
amenities and crime all render for those states. Only the price metric is
absent.

