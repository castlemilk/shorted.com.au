# Economy Phase-3 Round 2 — Design Spec (crime + Tier-2 sources)

Round 2 pulls the Tier-2 backlog (roadmap 2.2/2.3/2.7/2.8) plus **recorded
crime** (user-requested, not on the roadmap). All probes run live 2026-07-23
by the coordinator; codes PINNED. No DB migrations. Key finding: **no crime
SDMX flow exists** (1,223-flow scan) — crime is XLSX via the govfin-style
release-page machinery.

## A. ABS Monthly Household Spending Indicator (roadmap 2.8)

- SDMX `HSI_M` v**1.6.0**, monthly, source_key `abs-household-spending`
  ([release](https://www.abs.gov.au/statistics/economy/finance/monthly-household-spending-indicator/latest-release)).
- Filters: CATEGORY=`TOT`, PRICE_ADJUSTMENT=`CUR`, TSEST=`20` (seasadj —
  probed complete for all 9 STATE values incl. NT/ACT), MEASURE ∈ {`7`
  ($, UNIT_MULT=6 → ×1e6), `9` (through-the-year %, no scaling)}.
- Topic `spending`: `spending.household.total.{region}.seasadj` (aud) +
  `spending.household_yoy.total.{region}.seasadj` (percent). 18 series.
- Magnitude: AUS total ≈ $70–80B/mo (2026-05); yoy ±0–10%.
- Note in registry: supersedes retail turnover as the broad spending gauge
  (retail stays; the two overlap by design — documented, not deduped).

## B. ABS Lending Indicators — housing finance (roadmap 2.3)

- SDMX `LEND_HOUSING` v**1.1**, **quarterly** (the release moved off
  monthly), source_key `abs-lending-indicators`.
- Filters: MEASURE=`FIN_VAL`, LOAN_PURPOSE=`TOTDWELL` (total dwellings excl.
  refinancing — the plain OO/investor split does NOT exist under TOTHOUS,
  probed: TOTHOUS only carries FHB variants), LENDER_TYPE=`TOT`, TSEST=`20`,
  HOUSING_PURPOSE ∈ {`DV5167` owner_occupier, `DV5168` investor}, 9 REGIONs.
- Topic `lending`: `lending.new_commitments.{owner_occupier|investor}.{region}.seasadj`
  (aud, UNIT_MULT=6). 18 series.
- Housing-surface tie-in: investor commitments pairs with
  `credit.growth_yoy.investor_housing.aus.seasadj` (round 1).

## C. ABS Business Indicators (roadmap 2.2)

- SDMX `QBIS` v**1.0.0**, quarterly, source_key `abs-business-indicators`.
- **Currency reality (probed 2026-Q1)**: state×industry splits for
  sales/inventories/profits DIED at 2022-Q3. Current data: by-ANZSIC at AUS
  level for all measures; by-state only for all-industry TOTALS of
  M1 sales / M5 wages. Emit ONLY current families:
  - `business.gross_operating_profit.{anzsic-slug}.aus.seasadj` — MEASURE=`M7`,
    PRICE_ADJUSTMENT=`CUR`, REGION=`AUS`, TSEST=`20`, INDUSTRY≠TOT (~15
    divisions; mining ≈ $30–40B/qtr).
  - `business.sales.total.{state}.seasadj` + `business.wages.total.{state}.seasadj`
    — M1/M5, CUR, INDUSTRY=`TOT` (code TOT — verify literal in probe file
    /tmp/abs-QBIS.csv), TSEST=`20`, 8 states + AUS.
  - All aud, UNIT_MULT=6.
- **ANZSIC division slug map is a NEW static map** (iron rule): B mining,
  C manufacturing, D electricity-gas-water-waste, E construction,
  F wholesale-trade, G retail-trade, H accommodation-food-services,
  I transport-postal-warehousing, J information-media-telecommunications,
  K financial-insurance-services (NOTE: QBIS may exclude K — pin from the
  probe CSV's INDUSTRY values, do not guess), L rental-hiring-real-estate,
  M professional-scientific-technical, N administrative-support,
  O public-administration-safety, P education-training,
  Q health-care-social-assistance, R arts-recreation, S other-services.
  Dimensions carry `anzsic_division` (raw letter). This is DELIBERATELY a
  different vocabulary from the GICS map in markets.go — do not cross-map;
  registry note explains ANZSIC≠GICS.
- If an INDUSTRY value in the feed is missing from the map: skip + warn
  (same drift posture as markets).

## D. ABS Construction Work Done (roadmap 2.7)

- SDMX `CWD` v**1.0.0** (preliminary), quarterly, source_key
  `abs-construction-work-done`.
- Filters: MEASURE=`M1`, PRICE_ADJUSTMENT=`CVM` (chain volume — matches the
  SFD convention), SECTOR_OWN=`9` (total), TSEST=`20`,
  CONSTRUCTION_TYPE ∈ {`03` building, `04` engineering, `TOT` total},
  9 REGIONs (probed complete). UNIT_MULT=3 (thousands → ×1e3).
- Topic `construction`:
  `construction.work_done.{building|engineering|total}.{region}.seasadj`
  (aud). 27 series. Completes the approvals→activity lead/lag pair
  (roadmap 2.7); NOTE column name is `CONSTRUCTION_TYPE: Type of
  Construction` (label differs from id — parse by id prefix as usual).

## E. Recorded Crime — Victims (user-requested; XLSX)

- **No SDMX flow** — annual XLSX cubes on
  https://www.abs.gov.au/statistics/people/crime-and-justice/recorded-crime-victims/latest-release
  (WAF: mandatory shorted-data UA, same as govfin). Per-run discovery from
  the release page (govfin/petroleum pattern): find the cube link whose name
  contains "states and territories" (currently
  `2.%20Victims%20of%20crime%2C%20states%20and%20territories%20%28Tables%209%20to%2016%29.xlsx`
  under a year-versioned path) — fail loud if not found.
- Cube shape (verified by live ingest): Table 9 contains all eight states and
  territories as successive section blocks under one shared year header;
  Tables 10–16 are analytical breakdowns, not one sheet per state. Years are
  columns (1993→the current release end year; 2024 in the inspected workbook),
  with offence rows beneath each state section. Cells may be `np` (not
  published) — skip.
- Offence static map (pin from the actual sheet rows; expected set):
  Homicide and related offences → homicide, Assault → assault,
  Sexual assault → sexual-assault, Robbery → robbery,
  Unlawful entry with intent → unlawful-entry, Motor vehicle theft →
  motor-vehicle-theft, Other theft → other-theft. TOP-LEVEL offences only —
  skip sub-rows (Murder, Attempted murder…) and any unmapped row (warn).
- Topic `crime`: `crime.victims.{offence-slug}.{state}` — annual (period =
  Jan-1 of the year), unit `persons`, adjustment original, source_key
  `abs-recorded-crime-victims`, licence CC-BY-4.0. ~7 offences × 8 states.
- New `-mode crime`. Registry note: ABS cautions assault/sexual-assault
  counts are not comparable ACROSS states (recording practices differ) —
  carry `comparability=within-state-only` dimension on those two.
- **Derived rate** (extends `-mode derived`, new family per the round-1
  per-family resilience): `crime.victims_rate_100k.{offence-slug}.{state}` =
  victims(year) / erp(state, June quarter of that year) × 100,000 —
  `population.erp.total.{state}` is quarterly; select the `<year>-04-01`…
  `<year>-06-30` observation (June quarter); skip years with no erp obs.
  Unit `rate_per_100k`. Same comparability dimension carried.

## F. Web wiring

- Map metrics (`map-metrics.ts` registry): `spending.household_yoy` (diverging,
  percent) + `construction.work_done.total` (aud). Chip-row capacity: use the
  existing overflow behavior — if the row is at capacity per the round-1
  docs note, add ONLY spending_yoy and leave construction as a
  correlation-candidate-only series (judgment: check the current chip count
  vs the documented cap before adding).
- State-correlation candidates: household spending ($), new lending
  commitments investor, construction work done total. (Crime is annual —
  n≥12 monthly-aligned window can't clear; do NOT add crime to candidates.)
- State pages: new charts per the availability-registry convention —
  household spending, lending (OO vs investor two-line via the existing
  chart primitives if a two-series variant exists, else investor only),
  construction; plus a **crime card**: annual victims line with an
  offence selector + count/rate-per-100k toggle (both series exist; toggle
  switches series key prefix). Availability from the registry as always.
- Chat tool cheat-sheet: add the new key families (spending.household,
  lending.new_commitments, business.gross_operating_profit,
  construction.work_done, crime.victims + victims_rate_100k).

## Out of scope (evaluated)

- Visitor arrivals (`OAD_*`): no state dimension upstream — parked.
- `OMAD_VISA` migrant flows: overlaps `population.net_overseas_migration` — parked.
- `EWD` engineering detail by type: CWD's engineering total suffices.
- BOCSAR/state-police LGA-level crime: per-state bespoke (roadmap 2.6 class),
  suburb-surface material — separate workstream if wanted.
- QBIS dead 2022 state×industry families: never emit stale series.
