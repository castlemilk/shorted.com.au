# Suburb crime from PRIMARY sources → shorted.com.au — implementation plan

> Scratch plan for the Codex implementer (2026-07-22). **Do not commit this file.**
> This plan **SUPERSEDES the crime section (§3.1, §4.1, §6-crime) of
> `docs/openstats-ingestion-plan.md`**: the crime dataset is now built in-house from
> **primary ABS + state-police open data** (every source CC-BY / open-gov → commercial-OK,
> except WA — see §8), so the CC-BY-NC licence fork and the `HOUSING_CRIME_ENABLED`
> dark-flag gate are **removed**. The census/SEIFA/tenure work (openstats plan §3.2, migration
> for `suburb_demographics` columns) is unaffected and still valid — this plan does not touch it.
>
> **Reused verbatim from the openstats plan (still correct):** the SAL-2021 geography bridge to
> `suburb_demographics.sal_name` (measured 100% match, case-insensitive); the
> `suburb_crime_stats` + `mv_suburb_crime_latest` table shape; the `housing.proto` /
> `highlight-metrics.ts` read path (no new RPCs); the collector home
> (`services/house-price-collector`, `-mode` operator-run pattern); prod-DDL/MV/RSC landmines.

---

## 0. Executive summary (read this first)

- **Confirmed SUBURB-level open data:** NSW (BOCSAR), VIC (CSA), QLD (QPS crime-map API),
  SA (SAPOL), ACT (ACT Policing). **District-only, no bulk suburb file:** WA (WAPOL — suburb
  exists only behind an interactive Power BI / webform, and under a **non-commercial** ToS).
  **No suburb data at all → HATCH as no-data (never paint 0):** TAS, NT.
- **Common crime scheme chosen (4 types):** `break_ins` (residential burglary), `violent`
  (assault-based), `motor_vehicle` (motor-vehicle theft), `property_damage` (malicious/criminal
  damage). Each has a clean ABS CVS scaling anchor. `robbery` / `theft_from_vehicle` = optional
  Phase 3.
- **Scaling (per state `s`, crime type `c`, FY `y`):**
  `scale(s,c,y) = ABS_CVS_victims(s,c,y) / Σ_{u∈s} raw_police(u,c,y)` ;
  `adjusted(u,c,y) = raw_police(u,c,y) × scale(s,c,y)`.
- **Rate:** `rate_per_100k(u,c,y) = adjusted(u,c,y) / ERP(u,y) × 100000`.
- **Population-weighted national percentile rank (per c, y):**
  `pct_rank(u) = [ Σ_{v: rate_v < rate_u} pop_v  +  0.5·pop_u ] / Σ_{all with data} pop  × 100`
  (weight = FY ERP; no-data suburbs excluded from both numerator and denominator).
- **Migration:** `000091_add_suburb_crime` (**shifted +2: `000089`/`000090` taken by
  `crawl_run_status`**). `origin/main` tops out at **000087**; `000088` is held by the unmerged
  property_valuations PR and `000089` is now `crawl_run_status`, so the crime table takes `000091`
  and the sibling census/SEIFA takes `000092`. **RE-VERIFY** with
  `git fetch && git ls-tree origin/main services/migrations | tail` at build.
- **Genuine forks for the user (§8):** (1) **WA** — non-commercial ToS on the only suburb source;
  ship WA district-grain-apportioned + `source_licence='wa-tou-noncommercial'` gated OFF, or seek
  written permission, or exclude WA (hatch). (2) The **CVS prevalence-vs-incidence** modelling
  choice (raw victim-estimate scaler as the user specified, vs a reporting-rate multiplier) — the
  user's verbatim methodology is implemented as primary; the alternative is documented as a knob.

---

## 1. Source inventory

### 1.1 Scaling input + denominator (ABS, national)

| Role | Dataset | URL | Grain / key | Format | Licence | Coverage / cadence |
|---|---|---|---|---|---|---|
| **State scaler** | ABS **Crime Victimisation** (ex-4530.0), pooled state/territory tables | `.../crime-victimisation/2024-25/State and territory time series, pooled data (Tables 27a to 31d).xlsx` (landing: `/crime-victimisation/latest-release`) | **State/territory NAME only** (no ASGS code); map name→STE yourself | multi-tab XLSX data cube (NO CSV/SDMX) | **CC-BY-4.0** (commercial OK) | FY2008-09→FY2024-25; 2-yr pooled cols (11 rolling); **annual, ~9-mo lag**, next FY2025-26 = 17 Mar 2027 |
| **State population base** | ABS CVS **Populations (Tables 36a-37b)** (in-scope pop 15+, benchmarked to ERP) | `.../crime-victimisation/2024-25/Populations (Tables 36a to 37b).xlsx` | State | XLSX | CC-BY-4.0 | as above |
| **Suburb denominator + rank weight** | ABS **Regional population** ERP (`ERP_ASGS2021`, ex-3218.0) | SDMX: `https://data.api.abs.gov.au/rest/data/ABS,ERP_ASGS2021,1.0.0/all?format=csv` ; bulk: `/regional-population/2024-25/32180DS0001_2024-25.xlsx` | **SA2** (finest official annual ERP; **no SAL ERP exists**) | CSV/SDMX/XLSX | CC-BY-4.0 | annual, 30-Jun ref, released Mar/Apr |

**CVS shape (verified with openpyxl):** locate sheets by **descriptive title text in the
"Contents" tab, NOT hardcoded sheet number** (numbering drifts release-to-release). Rate sheets:
`Table 27c` = personal-crime rate (assault block), `Table 29c` = 3-yr-pooled (sexual assault +
robbery), `Table 30c` = household-crime rate (break-in / attempted break-in / MV theft / theft
from MV / malicious property damage / other theft). Each rate block = 8 state rows (NSW,VIC,QLD,
SA,WA,TAS,NT,ACT) + an "Australia" row, columns = pooled 2-yr periods (`2008–10`…`2023–25`).
`…a` = weighted estimate, `…b`/`…d` = RSEs (suppress cells with **RSE>25%**, esp. NT/ACT/TAS),
`…c` = the rate (%). **Use pooled (Tables 27–31), not single-year (32–35).**

### 1.2 Suburb-level police sources

| Jurisdiction | Dataset | Direct URL | Grain / key | Format | Licence (commercial?) | Coverage / cadence |
|---|---|---|---|---|---|---|
| **NSW** | BOCSAR "Recorded Criminal Incidents by month – by suburb" | `https://bocsarblob.blob.core.windows.net/bocsar-open-data/SuburbData.zip` (→ `SuburbData26Q1.csv`, 436MB) | free-text **Suburb** name (4,509) → SAL by name | ZIP→**wide CSV** (1 col/month, Jan1995→Mar2026); melt→long | **CC-BY** (yes) | monthly; quarterly release, ~1-qtr lag |
| **VIC** | CSA "Data Tables LGA Recorded Offences", **Table 03** (offences by LGA + postcode + suburb/town) | `https://files.crimestatistics.vic.gov.au/2026-06/Data_Tables_LGA_Recorded_Offences_Year_Ending_March_2026_0.xlsx` (**URL versioned by month — re-scrape the download-data page each qtr**) | **Suburb/Town + Postcode + LGA** (join on all 3) → SAL | multi-sheet **XLSX** (read_only stream; 370k rows) | **CC-BY-4.0** (yes; footnote says CC-BY-3.0-AU on some pages — both commercial-OK) | Apr2016→Mar2026 rolling; **quarterly, revisable** (re-pull full series each qtr) |
| **QLD** | QPS Online Crime Map API "Crime locations last 5 years" | `https://a5c7zwf7e5.execute-api.ap-southeast-2.amazonaws.com/dev/offences?locationType=SUBURB&locationName=<name>&startDate=mm-dd-yyyy&endDate=mm-dd-yyyy&format=JSON` ; lookup `.../dev/lut` (3,357 suburbs) | per-incident; **ABS Meshblock** on every row → SAL (reliable), suburb name secondary | **JSON REST** (per-incident, aggregate yourself) | **CC-BY-3.0-AU** (yes) | rolling ~5-yr window, ~2-day lag, `update_frequency=daily`; **you must archive per FY** (window rolls off) |
| **SA** | SAPOL "Crime Statistics" (one CSV per FY) | `https://data.sa.gov.au/data/dataset/860126f7-.../resource/.../download/data-sa-crime-2023-24-full-fy.csv` (CKAN `package_show?id=crime-statistics` lists all FYs) | **Suburb** (ALL-CAPS) + Postcode → SAL by name | **CSV** (7 cols; FY2011-12 resource is secretly `.xlsx`) | **CC-BY-4.0** (yes) | FY2010-11→current partial FY; "as required" |
| **ACT** | ACT Policing "Offences and other activities by Suburb" | `https://www.data.act.gov.au/api/views/2egm-dieb/files/<uuid>?filename=Website+Qtrly+Jun25.xlsx` (blob; standard resource API 403s — it's a `displayType:blob`) | free-text **Suburb** (upper-case) → SAL by name | multi-sheet **XLSX** (1 sheet/patrol district) | **CC-BY-4.0** (yes) | Q1 2014→latest; quarterly, ~1wk after qtr close |
| **WA** | WAPOL "Crime Time Series Data" (bulk) — **DISTRICT-only** | `https://www.wa.gov.au/media/48429/download?inline` (25-sheet XLSX; **no suburb sheet/column**). Suburb exists only in an embedded Power BI / per-suburb webform | District (bulk); suburb interactive-only | XLSX (bulk); no suburb bulk/API | **wa.gov.au ToU — NON-COMMERCIAL** (**NO** — bars commercial reuse w/o written State of WA permission) | Jan2007→current qtr; quarterly, provisional |
| **TAS** | Tas Police "Crime Statistics Supplement" — **STATE totals only**, PDF | `https://www.police.tas.gov.au/uploads/DPFEM-Crime-Statistics-Supplement-2024-25.pdf` | State only | PDF | (n/a) | annual FY; **no suburb/LGA data → HATCH** |
| **NT** | data.nt.gov.au "Current NT Crime Statistics" — **town/region only** | `https://data.nt.gov.au/dataset/.../nt_crime_statistics_aug_2025.csv` | 6 towns + "NT Balance" (SA2 only for balance); **no suburb for urban centres** | CSV | CC-BY | monthly; **no suburb data for named suburbs → HATCH** |

---

## 2. Offence-type crosswalk (the linchpin)

**Common scheme** (`crime_type`, aligned to ABS ANZSOC groups + the openstats set):

| `crime_type` | Concept (ANZSOC) | ABS CVS scaling anchor |
|---|---|---|
| `break_ins` | Residential unlawful entry / burglary (Div 07, residential) | CVS **"Break-in"** (household, Table 30 block) — *excludes* attempts & vehicles |
| `violent` | Assault & acts intended to cause injury (Div 02) | CVS **"Total physical and/or threatened assault"** (personal, Table 27 block) |
| `motor_vehicle` | Motor-vehicle theft (subdiv 0811) | CVS **"Motor vehicle theft"** (household, Table 30 block) |
| `property_damage` | Malicious/criminal property damage (Div 12) | CVS **"Malicious property damage"** (household, Table 30 block) |
| *(Phase 3)* `robbery` | Robbery (Div 06) | CVS **"Robbery"** (3-yr pooled, Table 29) |

**Per-jurisdiction mapping** (source category → common `crime_type`; SUM the listed lines):

| `crime_type` | NSW (BOCSAR) | VIC (CSA subgroup) | QLD (QPS 21-cat) | SA (SAPOL L3) | WA (WAPOL) | ACT |
|---|---|---|---|---|---|---|
| `break_ins` | Theft › **Break and enter dwelling** | **B311**+**B321** (residential agg + non-agg burglary; *exclude* B312/B322 non-res) | **Unlawful Entry** ⚠️(not split residential — see note) | SCT › **SCT - Residence** | **Burglary (Dwelling)** | **Burglary dwellings** |
| `violent` | Assault › **Domestic** + **Non-domestic** (+opt Assault Police) | **A211+A212+A231+A232** (serious+common, FV+non-FV) (+opt A22) | **Assault** | ACTS INTENDED TO CAUSE INJURY › Common + Serious(±injury) + Assault police + Other | Serious+Common Assault **(Family)** + **(Non-Family)** (+opt Assault Police Officer) | **Assault - FV** + **Assault - Non-FV** |
| `motor_vehicle` | Theft › **Motor vehicle theft** | **B41** Motor vehicle theft | **Unlawful Use of Motor Vehicle** | THEFT › **Theft/Illegal Use of MV** | **Stealing of Motor Vehicle** | **Motor vehicle theft** |
| `property_damage` | **Malicious damage to property** | **B21** Criminal damage (+opt B22 graffiti/B29) | **Other Property Damage** | PROPERTY DAMAGE › Other property damage (+opt Graffiti) | **Property Damage (Criminal/Damage)** | **Property damage** |

**Ambiguous mappings — be explicit (document in `crime_crosswalk.go` header):**

1. **`motor_vehicle` ≠ "steal FROM a motor vehicle".** Every jurisdiction has a *separate*
   theft-from-vehicle line (NSW "Steal from motor vehicle", VIC B42, SA "Theft from motor
   vehicle", WA "Stealing FROM Motor Vehicle"). **Never** sum it into `motor_vehicle`. (This is
   the single easiest crosswalk bug.)
2. **QLD `break_ins` over-scopes.** The QPS map API's `Unlawful Entry` is the *whole* burglary
   category (dwelling **and** non-dwelling) — it cannot be split residential-only at suburb grain
   via this API. Scaling to the CVS residential "Break-in" anchor corrects the *state total* but
   the *within-state distribution* still mixes non-residential. **Document this as a known QLD
   caveat**; do not silently treat it as residential-only. (QGSO's ANZSOC tables split it but are
   LGA-grain, not suburb.)
3. **FV/DV assault** is included in `violent` (recommend yes). Keep the FV split recoverable in
   raw if a future "family violence" metric is wanted, but the composite counts both.
4. **CVS defs are bespoke, not ANZSOC, and are PREVALENCE not incidence.** CVS "break-in" =
   forced entry to a residence, excludes attempts/vehicles; "robbery" excludes non-violent
   pickpocketing; a person robbed twice counts once. The police data are incident/offence
   counts. The scaler (§4c) rescales police counts to the CVS *victim estimate* per the user's
   verbatim methodology — this is a **cross-jurisdiction normalisation lever, not a claim that the
   two count the same thing**. See §4 "prevalence caveat".
5. **VIC suburb privacy roll-up:** Homicide/Sexual/Abduction/Blackmail collapse into "Other
   crimes against the person" at suburb grain — irrelevant to our 4 core types (none use them),
   but it means a future `sexual_assault` metric is impossible for VIC at suburb grain.
6. **SA sexual-assault rows are geo-suppressed** (`Suburb=NOT DISCLOSED`) — irrelevant to core;
   would block a future `sexual_assault` metric for SA too.

**CVS category → `crime_type`** (for the scaler): `Break-in`→`break_ins`;
`Total physical and/or threatened assault`→`violent`; `Motor vehicle theft`→`motor_vehicle`;
`Malicious property damage`→`property_damage`; (`Robbery`→`robbery`, Phase 3).

---

## 3. Geography bridge to ABS SAL 2021

**Reuse the openstats-plan bridge:** `suburb_demographics.sal_name` (from `SAL_NAME21`) is the
authoritative registry; `-mode census` must have run first. Join **case-insensitively** on
`LOWER(sal_name)`, apostrophe/punctuation-normalised (the repo's known `O'Connor`/`O'connor`
landmine). Fail the run if match rate < **98%** (fail-closed, like the economy importers).

| Source | Source key | Bridge to SAL | Apportionment / leakage |
|---|---|---|---|
| NSW | suburb name | name→`sal_name` | non-1:1 at merged/split/renamed localities (BOCSAR ~pre-2021 vintage, 4,509 names). Name-only. |
| VIC | suburb/town **+ postcode + LGA** | name(+postcode+LGA)→`sal_name` | 274 names appear under >1 LGA → **must** join name+postcode+LGA, then spot-check. |
| QLD | **ABS Meshblock code** (per incident) | **meshblock→SAL** via ABS ASGS Ed.3 mesh-block allocation file (`.../asgs.../correspondences`) — *reliable code join*, no name matching | best bridge of all sources; suburb name only a sanity check. Aggregate incidents → SAL → FY. |
| SA | suburb name (ALL-CAPS) | name→`sal_name` (case-fold; handle `MT`/`MOUNT`) | postcode NOT a clean 2nd key (25 names→>1 postcode); sanity-check postcode ∈ SA range (spotted a `3271` typo). |
| ACT | suburb name (upper) | name→`sal_name` | strip per-block "Total" rows; ACT has no LGA so suburb is finest. |
| WA | **district** (bulk) | district→SAL by **population-weighted split** (apportion district count to member SALs by Census pop share) OR suburb via webform (ToS-barred) | coarse; every SAL in a district gets the same *rate*, killing intra-district signal. See §8 fork. |

**No annual SAL ERP exists** (ABS ERP stops at SA2). Build `ERP(u,y)` in `crime_erp.go`:
base = **Census 2021 SAL usual-resident population** (already in `suburb_demographics.population`
via G01), **indexed year-to-year by the parent SA2's ERP growth** (`ERP_ASGS2021`, filtered
`SEX=3`/`AGE=TT`), with SA2↔SAL from the ABS mesh-block allocation (population-weighted; a SAL can
span >1 SA2). Household-based crime types (`break_ins`/`motor_vehicle`/`property_damage`) use the
same population weight for ranking; for the *state scaler denominator base* use state households
(Census-derived) for household crimes and state persons-15+ (CVS Populations tables) for `violent`.

---

## 4. Methodology implementation (core — exact steps + formulas)

All quantities are per **Australian financial year** `y` (Jul 1–Jun 30; `fy_ending=y` where
`y`=2024 means FY2023-24, matching CVS `date=2024-06-01` and ERP 30-Jun-2024). Normalise every
police cadence into FY buckets: NSW/QLD monthly→sum into FY; VIC "year-ending-March" & QLD rolling
→ recompute per FY from the finest available period; SA already FY; ACT quarterly→sum into FY; WA
quarterly→sum into FY.

**(a) Pull ABS CVS victims by state × crime_type × FY.**
For each state `s`, crime type `c`, FY `y`: read the pooled **rate** `r_cvs(s,c,y)` (%) from the
Contents-located rate sheet (Table 27c/30c; 29c for robbery). Convert to an estimated **victim
count**:

```
ABS_CVS_victims(s,c,y) = r_cvs(s,c,y)/100 × base(s,c,y)
  base = state persons aged 15+ (CVS Populations Tables 36/37)   for c = violent   (personal)
  base = state occupied private dwellings/households             for c ∈ household crimes
```

Suppress/flag any `(s,c,y)` whose CVS RSE > 25% (carry an `unreliable` flag; still usable but
noted — matters for NT/ACT/TAS, though TAS/NT have no suburb data anyway).

**(b) Pull police suburb counts, map via the §2 crosswalk.**
For each source, aggregate raw offence/incident counts to `(sal_code, c, y)` =
`raw_police(u,c,y)`. **Fill implicit zeros**: a suburb absent from a source-FY = 0 reported, NOT
NULL (SA/NSW especially) — otherwise trends read as gaps and the state sum is wrong.

**(c) SCALE per state so summed suburb counts match the CVS victim estimate.**

```
scale(s,c,y) = ABS_CVS_victims(s,c,y) / Σ_{u ∈ state s, has-data} raw_police(u,c,y)
adjusted(u,c,y) = raw_police(u,c,y) × scale(s,c,y)
```

This is the user's verbatim methodology: the police data set the *within-state distribution*; the
CVS sets the *nationally-consistent state total* (removing per-jurisdiction counting-rule
differences). Store both `raw_offence_count` and `adjusted_offence_count`.

> **Prevalence caveat / documented knob** (research gotcha #1 on CVS): CVS is *prevalence* (% of
> persons/households victimised ≥once), police data is *incidence* (offence/incident counts). The
> scaler above uses the raw victim-estimate as the target — implement it as the default because it
> is the user's stated methodology. Expose an alternative in `crime_scale.go` behind a constant
> (`SCALER_MODE = "victim_estimate" | "reporting_rate"`): the reporting-rate lever uses CVS Tables
> 28/31 ("% of most-recent incident reported to police") as `adjusted = raw / reporting_rate` to
> *gross up* police undercount instead of re-benchmarking to a prevalence total. Do NOT mix the
> two. Ship `victim_estimate`; note the alternative in the methodology footer.

**(d) Rate per 100k.**

```
rate_per_100k(u,c,y) = adjusted(u,c,y) / ERP(u,y) × 100000
```

Apply a **population floor** before publishing a rate: suburbs with ERP < 2,000 (BOCSAR's own
threshold) keep raw+adjusted counts but their `rate`/`pct_rank` are volatile — flag `small_pop`
and either suppress from the map or widen the pooled window. A suburb with 2 raw offences scaled
up by a large `scale` factor is the classic false-hotspot (landmine §9).

**(e) Population-weighted national percentile rank** (per `c`, `y`, over all has-data suburbs
nationally):

```
Let P = Σ_{v: has-data} pop_v            (national has-data population for c,y; pop = ERP(v,y))
pct_rank(u,c,y) = ( Σ_{v: rate_v < rate_u} pop_v  +  0.5·pop_u ) / P × 100     ∈ [0,100]
```

i.e. the share of the national population living in suburbs with a *lower* adjusted crime rate
than `u`, plus half of `u`'s own population (midpoint convention → stable ties/plateaus). Weight =
FY ERP, per the user's methodology ("Estimated Resident Populations of the relevant financial
years are used in the calculation of crime rates and ranks"). **No-data suburbs (TAS/NT, unmatched,
sub-floor if suppressed) are excluded from BOTH the `< rate_u` sum and `P`** — they hatch, never 0.

**FY handling / pooling:** compute per single FY, and also a **2-yr pooled** series
(`adjusted` averaged over `{y, y-1}`, re-ranked) for small-suburb stability — mirrors ABS CVS
pooling and the openstats default display. Store both (`pooled` boolean). The map reads the latest
pooled year; the profile trend chart reads the single-FY series.

---

## 5. Data model

**Migration `000091_add_suburb_crime.up.sql`** (shifted +2: 000089 taken by crawl_run_status;
RE-VERIFY number — see §0). `source_licence` is now the **primary's CC-BY** per row (no NC), so no licence kill-switch.

```sql
CREATE TABLE IF NOT EXISTS suburb_crime_stats (
    sal_code               TEXT     NOT NULL,   -- ABS SAL_CODE21 (bridged via sal_name/meshblock)
    crime_type             TEXT     NOT NULL,   -- 'break_ins'|'violent'|'motor_vehicle'|'property_damage'
    fy_ending              SMALLINT NOT NULL,   -- 2024 = FY2023-24
    pooled                 BOOLEAN  NOT NULL,   -- true = 2-yr pooled (map default)
    raw_offence_count      NUMERIC,             -- summed police offences/incidents (pre-scale)
    adjusted_offence_count NUMERIC,             -- raw × state CVS scale factor
    rate_per_100k          NUMERIC,             -- adjusted / ERP(FY) × 100000
    pct_rank               NUMERIC,             -- 0..100 national pop-weighted percentile (NULL if no data)
    population             INTEGER,             -- ERP(FY) used as denominator + rank weight
    scale_factor           NUMERIC,             -- state CVS scale applied (audit/debug)
    small_pop              BOOLEAN  NOT NULL DEFAULT false, -- ERP < 2000 (volatile rate)
    unreliable             BOOLEAN  NOT NULL DEFAULT false, -- CVS RSE>25% for the state anchor
    source_jurisdiction    TEXT     NOT NULL,   -- 'NSW'|'VIC'|'QLD'|'SA'|'WA'|'ACT'
    source                 TEXT     NOT NULL,   -- 'bocsar'|'vic_csa'|'qps_ocm'|'sapol'|'wapol'|'act_policing'
    source_licence         TEXT     NOT NULL,   -- 'CC-BY-4.0'|'CC-BY-3.0-AU'|'CC-BY'|'wa-tou-noncommercial'
    fetched_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sal_code, crime_type, fy_ending, pooled)
);
CREATE INDEX IF NOT EXISTS idx_suburb_crime_latest
    ON suburb_crime_stats (sal_code, pooled, fy_ending DESC);

-- Latest pooled snapshot for the map (one row per suburb × crime_type).
CREATE MATERIALIZED VIEW mv_suburb_crime_latest AS
SELECT DISTINCT ON (sal_code, crime_type)
       sal_code, crime_type, fy_ending, rate_per_100k, pct_rank,
       small_pop, source_jurisdiction, source_licence
FROM suburb_crime_stats
WHERE pooled AND pct_rank IS NOT NULL
  AND source_licence <> 'wa-tou-noncommercial'   -- WA gate (see §8); drop this line if WA excluded
ORDER BY sal_code, crime_type, fy_ending DESC;
CREATE UNIQUE INDEX idx_mv_suburb_crime_latest ON mv_suburb_crime_latest (sal_code, crime_type);
```

Fold `mv_suburb_crime_latest` into `refresh_housing_materialized_views()` (copy the `000086`
guarded-CONCURRENTLY fallback) **inside the migration**, else the collector's `refresh()` skips it.
Volume: ~14.3k SAL × 4 types × (~13 single + ~12 pooled FYs) ≈ **1.4M rows** — fine.

Down migration drops the MV + table and restores the prior `refresh_housing_materialized_views()`.

---

## 6. Collector: `-mode crime` in `services/house-price-collector`

Home is `house-price-collector` (suburb grain, housing read path, owns every suburb ingest).
Register `case "crime": runCrime(ctx, pool); refresh(ctx, pool)` in `main.go` (after
`electorates`), add to the `-mode` usage string, **NOT** to `"all"`/scheduled (operator-run, yearly
— like `census`). Reuse `absUA`, `cleanText`, `updateRun`, `refresh`.

**Files (new):**

| File | Responsibility |
|---|---|
| `crime.go` | `runCrime` orchestrator: load SAL registry → per-jurisdiction fetch+crosswalk → scale → ERP → rate → rank → `upsertCrime` → `refresh` → `updateRun("crime_primaries", latestFY, n, status, msg)` |
| `crime_abs_cvs.go` | ABS CVS XLSX parser (excelize, like the economy govfin XLSX importer). **Locate sheets via Contents-tab titles**, parse pooled rate blocks (27c/30c/29c) + Populations (36/37) + reporting-rate (28/31, for the alt scaler); return `map[state][crime_type][fy]{rate,rse,base}` |
| `crime_erp.go` | SAL FY ERP: Census-2021 SAL base × parent-SA2 ERP growth index (`ERP_ASGS2021` SDMX via `absdata`, `SEX=3`/`AGE=TT`); mesh-block SA2↔SAL allocation loader |
| `crime_crosswalk.go` | The §2 mapping tables as Go maps (`jurisdiction category → crime_type`, `CVS category → crime_type`) + documented ambiguity notes |
| `crime_src_nsw.go` | GET `SuburbData.zip` (`archive/zip`+`encoding/csv`), melt wide→long, filter crosswalked subcats, sum months→FY, name→SAL |
| `crime_src_vic.go` | Re-scrape download-data page for current Table-03 XLSX URL; `openpyxl`-style stream (excelize rows); pick Table 03; name+postcode+LGA→SAL |
| `crime_src_qld.go` | Loop `/dev/lut` suburbs → chunked `/dev/offences` calls (respect the **silent 100k-row cap** — chunk by date/geo), aggregate by **meshblock→SAL**, snapshot per FY (window rolls off → archive) |
| `crime_src_sa.go` | CKAN `package_show` → per-FY CSV download (handle the FY2011-12 `.xlsx` exception), sum `Offence count`, exclude `NOT DISCLOSED`, **do NOT add the FDV file**, name→SAL |
| `crime_src_act.go` | GET the `2egm-dieb` blob XLSX, walk stacked per-district blocks (strip "Total" rows), sum quarters→FY, name→SAL |
| `crime_src_wa.go` | (§8-gated) district XLSX (skip ~7 header rows/sheet) → population-weighted apportion to member SALs; tag `source_licence='wa-tou-noncommercial'` |
| `crime_scale.go` | `scale`, `rate`, and the population-weighted `pct_rank` passes (single + 2-yr pooled); `SCALER_MODE` constant |

Add `upsertCrime(ctx, pool, rows)` to `store.go` (batch `INSERT … ON CONFLICT
(sal_code, crime_type, fy_ending, pooled) DO UPDATE`, copy the `upsertDemographics` `pgx.Batch`
pattern). Env overrides for local fixtures (`CVS_XLSX_PATH`, `NSW_CRIME_ZIP`, `VIC_CRIME_XLSX`,
`SA_CRIME_DIR`, `ACT_CRIME_XLSX`, `WA_CRIME_XLSX`, `MESHBLOCK_ALLOC_PATH`) — mirrors
`CENSUS_DATAPACK_PATH`.

**Orchestration loop (crime.go):**
```
salByName := loadSalRegistry(pool)            // LOWER(sal_name) → sal_code; fail if empty
cvs := parseCVS(ctx, cvsXLSX)                 // state × crime_type × fy → {rate, base, rse}
erp := buildSalFyERP(ctx, pool)               // sal_code × fy → ERP
for each jurisdiction fetcher f:              // NSW,VIC,QLD,SA,ACT (+WA if enabled)
    raw[state] += f.fetch(ctx, salByName, crosswalk)   // (sal,crime_type,fy) → count; fill zeros
for state,c,fy: scale = cvs.victims(state,c,fy) / sum(raw in state)
                adjusted = raw × scale
compute pooled(2yr) adjusted; rate = adjusted/erp×1e5 (single+pooled)
pct_rank = popWeightedPercentile(rate, erp) per (c,fy,pooled) nationally
upsertCrime(...); refresh(ctx,pool); updateRun(...)
```
Idempotency: pure upsert on the natural key; re-running a source is a no-op; a newer source
release overlays newer FYs. Yearly cadence (CVS is the pacing input, ~9-mo lag). QLD needs its own
periodic snapshot job (rolling window) if history beyond 5yr is wanted — out of v1 scope.

---

## 7. Read path + frontend (no new RPCs)

**Proto** `proto/shortedapi/shorts/v1alpha1/housing.proto` (fields live in `housing.proto` only;
`ShortedStocksService` in `shorts.proto` shares the rpcs and is message-less — `proto_parity_test.go`
guards drift; then `cd proto && buf generate` and **commit all outputs incl. `sdks/java`**):

- **`SuburbSummary`** (current max field **27**) — map percentile ranks (latest pooled FY):
  ```protobuf
  double crime_break_ins_rank      = 28;  // 0..100 national pop-weighted percentile (0/absent = no data)
  double crime_violent_rank        = 29;
  double crime_motor_vehicle_rank  = 30;
  double crime_property_damage_rank= 31;
  ```
- **`GetSuburbProfileResponse`** (current max field **6**) — profile trend series:
  ```protobuf
  message SuburbCrimeYear {
    int32  fy_ending = 1;         // 2024 = FY2023-24
    string crime_type = 2;        // 'break_ins'|'violent'|'motor_vehicle'|'property_damage'
    double rate_per_100k = 3;
    double pct_rank = 4;
    bool   small_pop = 5;
  }
  repeated SuburbCrimeYear crime_series = 7;   // per GetSuburbProfileResponse
  ```
  (Optionally add flat latest ranks to `SuburbDemographics` (max field **18**, next 19) for the
  profile header — reuse the same 4 doubles.)

**Store/handler:**
- `postgres_house_prices.go` `ListStateSuburbs` (~L240): LEFT JOIN `mv_suburb_crime_latest`
  (flat: `jsonb_object_agg` or a 4-way join pivot to the 4 rank columns) → populate the new
  `SuburbSummary` fields. The MV already applies the WA gate via `source_licence`; no env flag
  needed for the CC-BY sources (licence posture §8).
- `GetSuburbProfile` (~L322): add a `suburb_crime_stats` single-FY query
  (`WHERE sal_code=$1 AND NOT pooled ORDER BY fy_ending`) → `crime_series`.
- `house_prices.go`: map store fields → proto; include the new fields in the `ListStateSuburbs`
  MemoryCache key (or flush on deploy).

**Frontend** `web/src/@/lib/housing/highlight-metrics.ts` (recipe G — selector/legend/dispatch are
automatic on registration; import `SuburbSummary` from `~/gen/shorts/v1alpha1/housing_pb`, never
`shorts_pb`):
- Extend `SuburbMetricInput` + `MetricKey` union + the `SuburbDatum` mapping in
  `state-suburb-explorer.tsx` / `state-suburb-map.tsx` with `crimeBreakInsRank`, `crimeViolentRank`,
  `crimeMotorVehicleRank`, `crimePropertyDamageRank`.
- Add 4 `HIGHLIGHT_METRICS` continuous entries, `value` = percentile rank, fixed
  `domain:[0,100]`, and a **danger `makeScale`** (amber→red; add like the `politicalLeanScale`
  diverging precedent — **do NOT** reuse the plain-amber ramp; high must read as *bad*).
  `value` returns **`null` when no data** (0-and-no-source) → `choropleth-map.tsx` hatches
  (TAS/NT/unmatched/sub-floor). Add `METRIC_ICONS` entries (reuse a sprite name or add via the
  brandbrain icon flow; non-blocking).
- `suburb-profile.tsx`: a crime section — the 4 latest ranks as danger-scaled tiles + a small
  multiples/line trend chart from `crime_series` (`dynamic ssr:false`, **format-key rule — pass a
  serializable `format` key + `MetricKey`, never a scale/formatter function across the RSC
  boundary**). Show the `source_jurisdiction` + attribution + "adjusted to ABS CVS, 2-yr pooled"
  methodology note; hatch legend explains TAS/NT no-data.

---

## 8. Licence posture

The derived dataset is **ours**; every input except WA is CC-BY / open-gov → **commercial OK with
attribution, NO kill-switch/flag needed** (this is the whole point of the primaries rebuild vs the
openstats CC-BY-NC fork).

| Source | Licence | Commercial? | Attribution string (show in map legend / methodology footer / `sources`) |
|---|---|---|---|
| ABS CVS + ABS ERP | CC-BY-4.0 | yes | "Australian Bureau of Statistics (Crime Victimisation; Regional Population), CC BY 4.0" |
| NSW BOCSAR | CC-BY | yes | "NSW Bureau of Crime Statistics and Research (BOCSAR), CC BY" |
| VIC CSA | CC-BY-4.0 | yes | "Crime Statistics Agency Victoria, CC BY 4.0" |
| QLD QPS | CC-BY-3.0-AU | yes | "Queensland Police Service / Queensland Government, CC BY 3.0 AU" |
| SA SAPOL | CC-BY-4.0 | yes | "South Australia Police (data.sa.gov.au), CC BY 4.0" |
| ACT Policing | CC-BY-4.0 | yes | "ACT Policing (data.act.gov.au), CC BY 4.0" |
| **WA WAPOL** | **wa.gov.au ToU — non-commercial** | **NO** | — (gated; see fork) |

**GENUINE FORK — WA (user must decide before WA ships):** the only suburb-level WA source sits
behind the general `wa.gov.au` Terms of Use, which **bars commercial reproduction without prior
written State-of-WA permission**, and the suburb data isn't even bulk-downloadable (Power BI /
webform only; scraping it would also breach the ToU). Options:
- **(A) Exclude WA** → WA suburbs hatch as no-data (cleanest, ships now). *Recommended for v1.*
- **(B) District-grain apportioned** from the CC-BY-*absent* bulk XLSX, `source_licence=
  'wa-tou-noncommercial'`, MV-gated OFF until permission — but the bulk file is under the *same*
  non-commercial ToU, so this still needs written permission before *display*, and it's coarse
  (intra-district signal lost).
- **(C) Seek written permission** from WA Police / State of WA, then flip WA rows to the granted
  licence and drop the MV gate line.

*(Note: this is the ONLY licence fork. TAS/NT are data-absence, not licence issues — they hatch.)*

---

## 9. Landmines

1. **Geography-key drift** — police suburb names are free-text on ~pre-2021 vintages (NSW 4,509,
   VIC 2,867 with 274 multi-LGA dupes, SA ~1,330); join case+punctuation-normalised, fail-closed
   <98% match. **Prefer QLD's meshblock code join** where available. `-mode census` must run first.
2. **`motor_vehicle` vs "steal FROM vehicle"** and **QLD `Unlawful Entry` includes non-dwelling**
   — the two headline crosswalk traps (§2 notes 1–2). Document in code.
3. **Small-count instability / false hotspots** — a suburb with 2 raw offences × a large state
   `scale_factor` = a fake red suburb. Enforce the ERP<2,000 `small_pop` flag + prefer the 2-yr
   pooled series for display; consider suppressing sub-floor suburbs from the map.
4. **CVS prevalence ≠ police incidence** (§4 caveat) — ship the user's `victim_estimate` scaler;
   keep the `reporting_rate` alternative documented; never mix. Label the map "adjusted to ABS CVS".
5. **CVS categories not 1:1 with police** (bespoke defs, not ANZSOC; attempts/vehicles excluded)
   — the crosswalk is a documented manual crosswalk, not a key join.
6. **CVS RSE suppression** — flag `(state,type,fy)` cells with RSE>25% (`unreliable`), esp.
   NT/ACT/TAS. **Locate CVS sheets by Contents-tab title, not sheet number** (numbering drifts).
7. **VIC URL is versioned per release month** (`/2026-06/…_0.xlsx`) — re-scrape the download-data
   page each run; never hardcode. QLD `/dev` API is unversioned prototype infra — monitor/fallback.
8. **QLD rolling 5-yr window + silent 100k-row cap** — chunk queries by date/geo; run your own
   per-FY archival snapshot (history rolls off).
9. **Implicit zeros** — absent suburb-FY = 0, not NULL (SA/NSW), or state sums and trends break.
10. **SA/VIC suppression** — SA sexual-assault = `NOT DISCLOSED` (excluded, fine for core); SA FDV
    CSV must **NOT** be added to the main file; VIC "Other crimes against the person" roll-up.
11. **WA/TAS/NT** — WA district-only + non-commercial ToU (§8 fork); TAS/NT no suburb data →
    **hatch, never paint 0** (both in the collector state-set and the frontend `value: null` path).
12. **ERP vintage / SAL-vs-SA2 mismatch** — no annual SAL ERP; base = Census-2021 SAL × SA2 ERP
    growth index; SA2↔SAL via mesh-block allocation (population-weighted, SAL can span >1 SA2).
    Match the SAL vintage to `suburb_demographics` (2021).
13. **Prod DDL** — apply `000091` via **session pooler 5432** + `PGOPTIONS="-c
    statement_timeout=0"` (txn pooler 6543 kills `CREATE/REFRESH MATERIALIZED VIEW CONCURRENTLY`);
    collector writes stay on 6543. First `REFRESH…CONCURRENTLY` needs the unique index present.
14. **MV refresh wiring** — add `mv_suburb_crime_latest` to `refresh_housing_materialized_views()`
    in the migration (guarded `000086` pattern), or `refresh()` silently skips it.
15. **RSC no-function-props** — dispatch metrics by serializable `MetricKey`/`format` key; charts
    stay `dynamic(ssr:false)`. Web imports from `housing_pb`, never `shorts_pb` (`bundle:budget`).
16. **Migration number** — `000091` (shifted +2: 000089 taken by crawl_run_status; 000088 =
    unmerged property_valuations); `git fetch && ls services/migrations | tail` at build (repo has collided before).

---

## 10. Ordered task list (phased)

### Phase 1 — Prove the pipeline end-to-end on the 3 best CC-BY suburb sources (NSW + VIC + QLD)
1. **Re-verify migration number** (`git fetch origin main && git ls-tree origin/main
   services/migrations | tail`). Write `000091_add_suburb_crime.{up,down}.sql` (§5: table + MV +
   fold MV into `refresh_housing_materialized_views()`).
2. `crime_crosswalk.go` — the §2 mapping tables (NSW/VIC/QLD + CVS) with documented ambiguities.
3. `crime_abs_cvs.go` — CVS XLSX parser (Contents-tab sheet location; pooled rate blocks
   27c/30c + Populations 36/37; RSE flag). Unit-test on a truncated CVS fixture.
4. `crime_erp.go` — SAL FY ERP builder (Census base × SA2 ERP growth; mesh-block SA2↔SAL).
5. `crime_src_nsw.go` (ZIP→melt→FY→SAL), `crime_src_vic.go` (Table-03 XLSX, name+postcode+LGA),
   `crime_src_qld.go` (lut→chunked offences→meshblock→SAL→FY snapshot). Unit-test each on a small
   fixture (incl. the `motor_vehicle`/`steal-from` trap, QLD 100k chunking, name-match fail-closed).
6. `crime_scale.go` — `scale`/`rate`/pop-weighted `pct_rank` (single + 2-yr pooled). Unit-test the
   percentile formula (weights, ties, no-data exclusion) against a hand-worked example.
7. `crime.go` + `-mode crime` in `main.go`; `upsertCrime` in `store.go`. `make test`.
8. **Local verify**: `make dev`, run `-mode census` then `-mode crime` against local DB; check
   `suburb_crime_stats`/`mv_suburb_crime_latest` populated for NSW/VIC/QLD; spot-check a known
   hotspot rank; confirm TAS/NT/SA/WA/ACT suburbs are absent (→ will hatch), not 0.

### Phase 2 — Add the remaining CC-BY suburb sources + resolve WA
9. `crime_src_sa.go` (CKAN per-FY CSV; FY2011-12 `.xlsx` exception; exclude `NOT DISCLOSED`;
   skip FDV file; implicit-zero fill) + `crime_src_act.go` (blob XLSX, stacked blocks, strip
   "Total"). Wire both into `runCrime`. Unit-test.
10. **USER FORK — WA (§8):** decide A (exclude/hatch, recommended v1) / B (district-apportioned,
    gated) / C (seek written permission). If A: no WA code, ensure WA suburbs hatch. If B/C:
    `crime_src_wa.go` (district XLSX skip-7-header-rows → pop-weighted SAL apportion,
    `source_licence='wa-tou-noncommercial'`, MV gate line kept).
11. **Prod rollout** (DB-before-code): apply `000091` via session pooler; run `-mode census`
    (if not current) then `-mode crime` against prod (CVS/ERP/all enabled states); verify MV;
    revalidate sweep (`/api/revalidate?path=/housing&flush=housing`).

### Phase 3 — Frontend metrics + profile section (+ optional extensions)
12. Proto: `SuburbSummary` fields 28–31 + `GetSuburbProfileResponse.crime_series` (§7);
    `cd proto && buf generate`; commit all outputs incl. `sdks/java`.
13. Store/handler: `ListStateSuburbs` LEFT JOIN `mv_suburb_crime_latest`; `GetSuburbProfile`
    `crime_series` query; cache-key/flush. Map fields → proto in `house_prices.go`.
14. Frontend: extend `SuburbMetricInput`/`MetricKey`/`SuburbDatum`; add 4 danger-scaled
    `HIGHLIGHT_METRICS` (fixed `[0,100]`, `null`→hatch) + `METRIC_ICONS`; crime section +
    trend chart in `suburb-profile.tsx`; attribution lines (§8) in the legend/methodology footer.
15. Tests: jest for the registry; storybook visual if the legend changes; local end-to-end
    `/housing/[state]` colour-by crime + a suburb profile. `make test`.
16. *(Optional)* Phase-3 extras: `robbery` (CVS 3-yr pooled Table 29 + per-state robbery lines);
    LGA-grain crime onto the `lga` dimension; yearly Cloud Run scheduler + QLD archival snapshot job.
```
