# Crime read path + frontend — implementation spec

**Status: DESIGN — ready for implementation. No code has been changed.**

Surface the now-live `suburb_crime_stats` data (Phase 1 / NSW, 527k rows in prod,
written by PR #339 / branch `feat/suburb-crime-pipeline`, migration
`000090_add_suburb_crime`) on the housing suburb explorer:

1. Three new **"Colour by" map metrics** on `/housing/[state]` — national
   population-weighted percentile rank per crime type.
2. A **Crime & safety section** on `/housing/[state]/[suburb]` — rate/100k +
   percentile badge + FY + attribution.

No new RPCs. Fields ride the existing `ListStateSuburbs` / `GetSuburbProfile`
(`proto/shortedapi/shorts/v1alpha1/housing.proto` lines 22–29). This supersedes
the sketch in `docs/crime-data-from-primaries-plan.md` §7 (written pre-ingest;
prod reality differs — see §0.2 below).

---

## 0. Ground truth (verified 2026-07-23)

### 0.1 What is live in prod

- **Base table `suburb_crime_stats`** (527k rows: ~272k single-FY + ~255k
  2-yr-pooled; NSW only, 4,419 suburbs). Columns (migration
  `000090_add_suburb_crime.up.sql`, worktree `~/projects/.worktrees/shorted-crime`,
  lines 25–43): `sal_code, crime_type, fy_ending, pooled, raw_offence_count,
  adjusted_offence_count, rate_per_100k, pct_rank, population, scale_factor,
  small_pop, unreliable, source_jurisdiction, source, source_licence, fetched_at`.
  PK `(sal_code, crime_type, fy_ending, pooled)`.
- **`crime_type` values with data**: `break_ins` | `violent` | `motor_vehicle`
  (3 types). The collector's `coreCrimeTypes` (`crime_crosswalk.go` line 46)
  also lists `property_damage`, but prod has no ranked property_damage rows —
  design for 3, leave field-number room for a 4th (§2).
- **`mv_suburb_crime_latest`** (~17k rows): latest **pooled** row per
  `(sal_code, crime_type)`. As committed (000090 lines 51–62) it exposes
  `small_pop` but **NOT `unreliable` and NOT `population`** — so the mandatory
  read gate `NOT small_pop AND NOT unreliable` **cannot be applied from the MV
  as-is**. (Prod was DDL'd manually; treat its exact MV shape as
  non-authoritative — §1 makes it deterministic.)
- `refresh_housing_materialized_views()` already refreshes the MV
  (000090 lines 68–98, guarded CONCURRENTLY→blocking); the collector calls it
  post-ingest. No refresh wiring needed.

### 0.2 Semantics that drive the design

- **`pct_rank` is strictly > 0 whenever data exists** — the formula
  `(Σ pop_below + 0.5·pop_self)/Σpop × 100` (000090 lines 17–19) always
  includes the suburb's own half-weight. So **`0` is a safe "no data" sentinel**
  for proto doubles, same convention as `federal_tpp_alp`
  (`highlight-metrics.ts` line 246: `s.federalTppAlp > 0 ? … : null`).
  `rate_per_100k` CAN be legitimately 0 (zero offences) — **gate availability
  on rank, never on rate**.
- **The gate is not optional**: ungated, tiny rural localities (few offences ÷
  tiny ERP) paint absurd rates (399,000/100k) at rank 100. `small_pop`
  (ERP < 2000) + `unreliable` (CVS anchor RSE > 25%) quarantine them.
- **Coverage**: NSW only today. VIC/QLD/SA/ACT are future ingests; TAS/NT have
  no suburb-level source; WA is licence-gated (`wa-tou-noncommercial`, never
  written in Phase 1). All of these must render as **no-data (hatch / absent
  section), never zero**.
- **Pooled vs single-FY**: `pooled=true` (2-yr average) is the stabilised map
  default; `pooled=false` is the per-year series (future trend chart). This
  spec uses **pooled-latest everywhere** so the profile number equals the map
  colour (fork note in §8 if the owner prefers single-FY on the profile).

---

## 1. Data-model decision: rebuild the MV (migration `000092`) — RECOMMENDED

**Decision: (a) rebuild `mv_suburb_crime_latest` with the gate baked in and the
flag columns exposed.** Rejected: (b) reading the base table per-request.

Why (a):

- The committed MV **lacks `unreliable`** (and `population`), so the mandatory
  gate can't be expressed against it; and because prod DDL was hand-applied,
  the deployed MV shape isn't even guaranteed to match the file. A
  `DROP + CREATE` migration makes the prod shape **deterministic**.
- Baking `NOT small_pop AND NOT unreliable` into the MV makes it **impossible
  for any future reader** (tooltip, screener, API consumer, ad-hoc SQL) to
  forget the gate — the quarantined rows simply don't exist on the read path.
  We still re-assert the gate in reader SQL as defense-in-depth (no-op, free).
- The MV pre-collapses 527k base rows to a ≤13.3k-row latest-pooled snapshot
  with a unique `(sal_code, crime_type)` index — the `ListStateSuburbs` join
  stays trivial. Option (b) would run `DISTINCT ON` over 527k rows inside the
  already-heavy suburb list query for every cold cache, for zero benefit.
- Freshness is identical: the collector's `refresh()` already covers this MV.

**Migration number: `000092`.** Verified: `000090` = crime
(`feat/suburb-crime-pipeline`), `000091` = `add_property_valuation_granularity`
(unmerged branch `fix/property-resolver-search`); `main` currently tops out at
`000086`. **Re-verify at merge time** (`ls services/migrations | sort | tail`)
— see landmine §7.7 for the golang-migrate skip hazard.

### `services/migrations/000092_crime_read_gating.up.sql`

```sql
-- Rebuild mv_suburb_crime_latest as the GATED read snapshot. The read path
-- MUST NOT surface quarantined rows: small_pop (ERP < 2000 → volatile rates,
-- e.g. 399,000/100k at rank 100) and unreliable (CVS state anchor RSE > 25%).
-- Baking the gate into the MV makes it structurally impossible for a reader
-- to forget it; population + the (now constant-false) flags are exposed so
-- readers can re-assert the gate and tooltips can show the ERP denominator.
-- DROP+CREATE also makes the prod MV shape deterministic (000090 was
-- hand-applied to prod; the committed version lacks `unreliable`/`population`).
DROP MATERIALIZED VIEW IF EXISTS mv_suburb_crime_latest;
CREATE MATERIALIZED VIEW mv_suburb_crime_latest AS
SELECT DISTINCT ON (sal_code, crime_type)
       sal_code, crime_type, fy_ending, rate_per_100k, pct_rank,
       population, small_pop, unreliable,
       source_jurisdiction, source, source_licence
FROM suburb_crime_stats
WHERE pooled AND pct_rank IS NOT NULL
  AND NOT small_pop AND NOT unreliable
  AND source_licence <> 'wa-tou-noncommercial'
ORDER BY sal_code, crime_type, fy_ending DESC;

-- Required for REFRESH ... CONCURRENTLY (refresh_housing_materialized_views()).
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_crime_latest
    ON mv_suburb_crime_latest (sal_code, crime_type);
```

### `services/migrations/000092_crime_read_gating.down.sql`

Restore the exact 000090 MV definition (copy lines 51–62 of
`000090_add_suburb_crime.up.sql`: DROP, CREATE without
`population`/`unreliable` and without the flag gate, plus the unique index).

`refresh_housing_materialized_views()` needs **no change** — the MV name is
unchanged and the function already has the guarded-CONCURRENTLY block for it.
`CREATE MATERIALIZED VIEW` defaults to `WITH DATA`, so it's populated at apply
time.

**Prod application** (owner-run, harness-gated): session pooler **port 5432**
(not txn pooler 6543) with `PGOPTIONS="-c statement_timeout=0"` — the standard
housing-DDL runbook. **DB before code**: apply 000092 to prod BEFORE deploying
the service (the new store SQL selects `unreliable`, which the current prod MV
may not have) — same rollout order as local-insights (PR #229/#232).

---

## 2. Proto — `proto/shortedapi/shorts/v1alpha1/housing.proto`

No new RPCs → **no `shorts.proto` change** (the legacy `ShortedStocksService`
is message-less and shares rpcs only; `proto_parity_test.go`
(`services/shorts/internal/services/shorts/proto_parity_test.go` lines 12–19)
enforces **rpc-level** parity — message-field additions don't touch it). No
`serve.go` mount, no `next.config.mjs` rewrite, no `internalOnlyMethods` entry.

### 2.1 `SuburbSummary` — map/list ranks (current max field = 27, lines 155–187)

Flat doubles, matching the existing flat-scalar map-metric convention
(`federal_tpp_alp`, `connectivity_quality_score`). `0` = no data (§0.2).

```protobuf
  // Crime percentile ranks (national population-weighted, 0..100, higher =
  // more reported crime; latest 2-yr-pooled FY, CVS-adjusted). 0 = no data —
  // pct_rank is strictly > 0 whenever a reliable observation exists. Small-
  // population and statistically-unreliable suburbs are gated server-side
  // (mv_suburb_crime_latest) and read as no-data. NSW (BOCSAR) only in
  // Phase 1; uncovered states/TAS/NT stay 0. CC-BY sources (see plan §8).
  double crime_break_ins_rank      = 28;
  double crime_violent_rank        = 29;
  double crime_motor_vehicle_rank  = 30;
  // field 31 reserved-by-convention for crime_property_damage_rank (collector
  // publishes the type once a CVS anchor exists; do not use 31 for anything else).
```

### 2.2 Profile — new messages + `GetSuburbProfileResponse` field 7 (current max = 6, lines 269–276)

Repeated per-type stats (not 4 flat fields) so a future `property_damage` /
robbery type flows through without another proto change, plus response-level
source attribution. **Absent message = no data** (null-not-zero for TAS/NT and
uncovered states). Fields are int32/double only — no int64 → no
protobuf-es BigInt/toJson trap.

```protobuf
// Latest reliable crime observation for one crime type (2-yr pooled,
// CVS-adjusted; small_pop/unreliable rows are gated out server-side).
message SuburbCrimeStat {
  string crime_type    = 1;  // 'break_ins' | 'violent' | 'motor_vehicle' (+ future types)
  double rate_per_100k = 2;  // adjusted offences per 100k residents (can be 0)
  double pct_rank      = 3;  // 0..100 national pop-weighted percentile; > 0 always
  int32  fy_ending     = 4;  // 2025 = FY2024-25 (end year of the pooled window)
}

// Per-suburb crime block. Message absent (null) = no reliable data for this
// suburb (uncovered state, TAS/NT, or gated small_pop/unreliable).
message SuburbCrime {
  repeated SuburbCrimeStat stats = 1;
  string source_jurisdiction     = 2;  // 'NSW'
  string source                  = 3;  // 'bocsar'
  string source_licence          = 4;  // 'CC-BY-4.0'
}
```

```protobuf
message GetSuburbProfileResponse {
  …existing fields 1–6…
  SuburbCrime crime = 7;   // null when the suburb has no gated crime data
}
```

(Do NOT add fields to `SuburbDemographics` — max 18, untouched.)

### 2.3 Generate

```bash
cd proto && buf generate
```

Commit **ALL** outputs: `web/src/gen/`, `services/gen/`, **and the `sdks/java`
churn** (the committed Java SDK tracks the protos).

---

## 3. Backend

### 3.1 Store — `services/shorts/internal/store/shorts/postgres_house_prices.go`

**(a) `SuburbSummaryRow`** (lines 125–178) — append:

```go
	// Crime percentile ranks (latest pooled FY, gated MV); 0 = no data.
	CrimeBreakInsRank     float64
	CrimeViolentRank      float64
	CrimeMotorVehicleRank float64
```

**(b) `ListStateSuburbs`** (lines 240–314) — add the gated pivot join. Insert
into the SELECT list (after the `connectivity` columns, line 266):

```sql
	       COALESCE(ROUND(cr.break_ins_rank::numeric, 1), 0),
	       COALESCE(ROUND(cr.violent_rank::numeric, 1), 0),
	       COALESCE(ROUND(cr.motor_vehicle_rank::numeric, 1), 0)
```

and after the `suburb_connectivity` join (line 270):

```sql
	LEFT JOIN (
		-- Latest pooled, CVS-adjusted crime ranks, pivoted per suburb. The MV
		-- (000092) is already gated; the WHERE re-asserts the small_pop/
		-- unreliable gate as defense-in-depth (no-op, free).
		SELECT sal_code,
		       MAX(pct_rank) FILTER (WHERE crime_type = 'break_ins')     AS break_ins_rank,
		       MAX(pct_rank) FILTER (WHERE crime_type = 'violent')       AS violent_rank,
		       MAX(pct_rank) FILTER (WHERE crime_type = 'motor_vehicle') AS motor_vehicle_rank
		FROM mv_suburb_crime_latest
		WHERE NOT small_pop AND NOT unreliable
		GROUP BY sal_code
	) cr ON cr.sal_code = d.sal_code
```

Add the three fields to the `rows.Scan` (after
`&r.DominantNbnTech, &r.ConnectivityQualityScore`, line 308):
`&r.CrimeBreakInsRank, &r.CrimeViolentRank, &r.CrimeMotorVehicleRank`.

`LEFT JOIN` + `COALESCE(…, 0)` gives **null-not-zero semantics via the 0
sentinel**: TAS/NT/VIC/QLD suburbs (no MV rows) get 0 → proto omits the field
→ frontend maps 0 → `null` → hatch. `ROUND(…, 1)` keeps the 4.4k-row JSON
payload lean (Connect JSON transport).

**(c) Profile crime rows** — new row type + helper (mirror the
`similarSuburbs` soft-fail pattern, lines 418–420 / 428+):

```go
// SuburbCrimeStatRow is one latest-pooled, gated crime observation.
type SuburbCrimeStatRow struct {
	CrimeType    string
	FYEnding     int32
	RatePer100k  float64
	PctRank      float64
	Jurisdiction string
	Source       string
	Licence      string
}
```

Add `Crime []SuburbCrimeStatRow` to `SuburbProfileRow` (struct at lines
181–226).

```go
// suburbCrime returns the latest pooled, gated crime stats for one suburb.
// Empty slice = no reliable data (uncovered state / gated small_pop).
func (s *postgresStore) suburbCrime(ctx context.Context, salCode string) ([]SuburbCrimeStatRow, error) {
	const q = `
		SELECT crime_type, fy_ending, COALESCE(rate_per_100k, 0),
		       COALESCE(pct_rank, 0), source_jurisdiction, source, source_licence
		FROM mv_suburb_crime_latest
		WHERE sal_code = $1 AND NOT small_pop AND NOT unreliable
		ORDER BY crime_type`
	…standard Query/Scan loop…
}
```

Call it at the end of `GetSuburbProfile` (next to the `similarSuburbs` call,
line 418):

```go
	if cr, err := s.suburbCrime(ctx, salCode); err == nil {
		p.Crime = cr
	}
```

(Soft-fail like `similarSuburbs`: the profile still renders if the crime query
errors.)

> Base-table equivalent (documented for reference / the single-FY fork §8 —
> NOT used by this spec):
> ```sql
> SELECT DISTINCT ON (crime_type)
>        crime_type, fy_ending, rate_per_100k, pct_rank
> FROM suburb_crime_stats
> WHERE sal_code = $1 AND pooled AND pct_rank IS NOT NULL
>   AND NOT small_pop AND NOT unreliable
>   AND source_licence <> 'wa-tou-noncommercial'
> ORDER BY crime_type, fy_ending DESC;
> -- single-FY variant: swap `pooled` → `NOT pooled`
> ```

No `Store` interface signature changes (both methods keep their signatures) →
no mock regeneration needed.

### 3.2 Handler — `services/shorts/internal/services/shorts/house_prices.go`

**`ListStateSuburbs`** (proto mapping, lines 120–144) — add to the
`SuburbSummary` literal:

```go
	CrimeBreakInsRank: r.CrimeBreakInsRank, CrimeViolentRank: r.CrimeViolentRank,
	CrimeMotorVehicleRank: r.CrimeMotorVehicleRank,
```

**`GetSuburbProfile`** (lines 189–296) — two additions:

1. Fill the same three summary fields from `p.Crime` (so the embedded summary
   matches the list/map), then build the message; after the `banner` block
   (~line 258):

```go
	var crime *shortsv1alpha1.SuburbCrime
	if len(p.Crime) > 0 {
		crime = &shortsv1alpha1.SuburbCrime{
			SourceJurisdiction: p.Crime[0].Jurisdiction,
			Source:             p.Crime[0].Source,
			SourceLicence:      p.Crime[0].Licence,
		}
		for _, c := range p.Crime {
			crime.Stats = append(crime.Stats, &shortsv1alpha1.SuburbCrimeStat{
				CrimeType: c.CrimeType, RatePer100K: c.RatePer100k,
				PctRank: c.PctRank, FyEnding: c.FYEnding,
			})
			switch c.CrimeType {
			case "break_ins":
				summary.CrimeBreakInsRank = c.PctRank
			case "violent":
				summary.CrimeViolentRank = c.PctRank
			case "motor_vehicle":
				summary.CrimeMotorVehicleRank = c.PctRank
			}
		}
	}
```

   (Check the generated field name for `rate_per_100k` — protobuf-go renders
   it `RatePer_100K` or `RatePer100K` depending on version; use whatever
   `buf generate` emits.)

2. Add `Crime: crime` to the `GetSuburbProfileResponse` literal (line 259–286).
   `crime` stays **nil** when the store slice is empty — the wire-level
   null-not-zero contract.

**Caching**: `s.cache` is the in-process `MemoryCache`
(`cache.go` lines 233–239, keys `state_suburbs`/`suburb_profile`) — a deploy
restarts the process and flushes it. **No cache-key change needed.**

---

## 4. Frontend

All imports from `~/gen/shorts/v1alpha1/housing_pb` — **never `shorts_pb`**
(`bundle:budget` enforces).

### 4.1 `web/src/@/lib/housing/highlight-metrics.ts` — three new "Colour by" metrics

1. **`SuburbMetricInput`** (lines 16–39) — append:

```ts
  // crime percentile ranks (0 = no data; > 0 always when covered)
  crimeBreakInsRank: number;
  crimeViolentRank: number;
  crimeMotorVehicleRank: number;
```

2. **`MetricKey`** union (lines 41–44) — add
   `"crime_break_ins" | "crime_violent" | "crime_motor_vehicle"`.

3. **Danger scale** (next to `politicalLeanScale`, line 347). Sequential
   yellow→red — deliberately NOT the amber price ramp, so high crime reads as
   *bad*, not *expensive*. `interpolateYlOrRd` comes from the already-imported
   `d3-scale-chromatic`:

```ts
/** Sequential yellow→red danger ramp for crime percentile ranks (0..100). */
export function crimeRankScale(): (v: number) => string {
  return scaleSequential((t: number) => interpolateYlOrRd(0.15 + 0.8 * t)).domain([0, 100]);
}
```

4. **`HIGHLIGHT_METRICS` entries** — insert after the `state_party` entry
   (line 255), before `amenity_density`:

```ts
  {
    kind: "continuous", key: "crime_break_ins", label: "Break-ins",
    legendLabel: "Break-ins (national percentile)",
    value: (s) => (s.crimeBreakInsRank > 0 ? s.crimeBreakInsRank : null),
    format: (v) => `${Math.round(v)}th pctile`,
    domain: [0, 100], makeScale: () => crimeRankScale(),
  },
  {
    kind: "continuous", key: "crime_violent", label: "Violent crime",
    legendLabel: "Violent crime (national percentile)",
    value: (s) => (s.crimeViolentRank > 0 ? s.crimeViolentRank : null),
    format: (v) => `${Math.round(v)}th pctile`,
    domain: [0, 100], makeScale: () => crimeRankScale(),
  },
  {
    kind: "continuous", key: "crime_motor_vehicle", label: "Car theft",
    legendLabel: "Motor-vehicle theft (national percentile)",
    value: (s) => (s.crimeMotorVehicleRank > 0 ? s.crimeMotorVehicleRank : null),
    format: (v) => `${Math.round(v)}th pctile`,
    domain: [0, 100], makeScale: () => crimeRankScale(),
  },
```

   `value → null` on 0 → `choropleth-map.tsx` paints the `nodata-hatch`
   pattern (lines 17 + 266) — TAS/NT and every un-ingested state hatch
   automatically. The selector, gradient legend and continuous dispatch in
   `state-suburb-map.tsx` (lines 106–124, 140–159, 187–196) are automatic on
   registration (architecture doc §9 recipe G).

5. **`METRIC_ICON`** (lines 330–337) — TypeScript forces entries for the new
   keys. The sprite (`housing-icons.generated.ts`) has no crime glyph yet; use
   an interim existing icon and regenerate the sprite later (§8):

```ts
  crime_break_ins: "dwellings", crime_violent: "population", crime_motor_vehicle: "train",
```

   (Interim picks are cosmetic — swap all three to a real `crime`/`safety`
   sprite icon when generated via `web/scripts/housing-icons/` +
   `pack-sprite.mjs`.)

### 4.2 `web/src/@/components/housing/state-suburb-map.tsx` — `SuburbDatum` (lines 18–38)

```ts
  crimeBreakInsRank: number; crimeViolentRank: number; crimeMotorVehicleRank: number;
```

No other change — the component reads `metric.kind` generically.

### 4.3 `web/src/@/components/housing/state-suburb-explorer.tsx` — proto→datum mapping (lines 35–66)

```ts
      crimeBreakInsRank: s.crimeBreakInsRank, crimeViolentRank: s.crimeViolentRank,
      crimeMotorVehicleRank: s.crimeMotorVehicleRank,
```

(Old sessionStorage entries lacking the fields deserialize as `undefined` →
`> 0` is false → hatch; benign, expires with the session. No cache-key bump
needed.)

### 4.4 `web/src/@/components/housing/suburb-profile.tsx` — Crime & safety section

New `CrimeCard`, rendered in the left "demographics — grouped" column after
`<FederalRep s={s} />` (line 181):

```tsx
            <CrimeCard crime={data.crime} />
```

Component (follow the `CultureStats`/`CouncilCard` patterns, lines 447–471 /
356–384 — this file is `"use client"`, so using `crimeRankScale` directly is
fine; the RSC no-function-props rule applies to server→client props, not
in-component use):

```tsx
type Crime = NonNullable<Awaited<ReturnType<typeof getSuburbProfileClient>>>["crime"];

const CRIME_LABELS: Record<string, string> = {
  break_ins: "Break-ins", violent: "Violent crime", motor_vehicle: "Car theft",
};
const fyLabel = (fy: number) => `FY${fy - 1}–${String(fy).slice(2)}`;
const ordinal = (n: number) => {
  const v = Math.round(n), r = v % 10, t = v % 100;
  return `${v}${t >= 11 && t <= 13 ? "th" : r === 1 ? "st" : r === 2 ? "nd" : r === 3 ? "rd" : "th"}`;
};

/** Crime & safety — latest 2-yr-pooled, CVS-adjusted stats. Renders nothing
 * when the suburb has no reliable data (uncovered state, TAS/NT, or a
 * small-population/unreliable suburb gated server-side) — never zeros. */
function CrimeCard({ crime }: { crime: Crime | undefined }) {
  const stats = crime?.stats ?? [];
  if (stats.length === 0) return null;
  const fy = stats[0]!.fyEnding;
  return (
    <div>
      <SectionHeading icon="dwellings">Crime &amp; safety</SectionHeading>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
        {stats.map((c) => (
          <div key={c.crimeType} className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground">{CRIME_LABELS[c.crimeType] ?? c.crimeType.replace(/_/g, " ")}</div>
            <div className="mt-1 font-mono text-lg tabular-nums text-foreground">
              {Math.round(c.ratePer100K).toLocaleString()}<span className="text-xs text-muted-foreground">/100k</span>
            </div>
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-black"
                 style={{ backgroundColor: crimeRankScale()(c.pctRank) }}>
              {ordinal(c.pctRank)} percentile
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground opacity-70">
        {fyLabel(fy)}, 2-yr pooled. Recorded incidents: NSW Bureau of Crime Statistics
        and Research (BOCSAR); adjusted to the ABS Crime Victimisation Survey; ABS ERP
        population denominator. All CC BY 4.0. Percentile is the national
        population-weighted rank — higher means more reported crime.
      </p>
    </div>
  );
}
```

Notes:
- Import `crimeRankScale` from `@/lib/housing/highlight-metrics`.
- Section icon: interim `"dwellings"` until a `crime` sprite icon exists.
- The badge text colour may need `text-black`/`text-white` switching on the
  darker end of YlOrRd — acceptable to hardcode a threshold
  (`c.pctRank > 65 ? "text-white" : "text-black"`).
- **Attribution line is mandatory** (BOCSAR + ABS are CC-BY — attribution is
  the licence condition). If `crime.sourceJurisdiction` ≠ `"NSW"` in future
  phases, generalize the wording from `crime.source`/`sourceJurisdiction`
  rather than hardcoding — fine to hardcode NSW/BOCSAR for Phase 1 since the
  message carries the fields.

### 4.5 `web/src/@/components/housing/data-attribution.tsx` — map-level attribution

The state map shows `<DataAttribution />` (rendered from
`state-suburb-explorer.tsx` line 208). Add BOCSAR to the static credit line,
e.g. append: `NSW Bureau of Crime Statistics and Research (CC BY 4.0; crime
rates adjusted to the ABS Crime Victimisation Survey).` Update its snapshot
test `data-attribution.test.tsx` if it asserts text.

### 4.6 Optional polish — `suburb-tooltip.tsx`

Add a one-line "Break-ins: 87th pctile" row when `crimeBreakInsRank > 0`
(the tooltip already receives the full `SuburbDatum`). Optional; skip if
crowded.

### 4.7 No-data handling summary (requirement 4c)

- **Map**: metric `value()` returns `null` for rank 0 → hatch (existing
  `nodata-hatch` pattern). Whole uncovered states (VIC/QLD/TAS/NT/…) render
  fully hatched when a crime metric is selected — same accepted precedent as
  `school_sector` (VIC+QLD-only) and `price` (SA+VIC-only). Do NOT auto-hide
  the metric per-state in v1.
- **Profile**: `CrimeCard` returns `null` when `crime` is absent/empty — the
  section simply doesn't exist for a TAS suburb (matches `CultureStats` /
  `SchoolSectorCard` skip-when-empty precedent).
- **Never render 0** as a rate/rank for an uncovered suburb.

---

## 5. Rollout / caching notes

- **Order**: merge PR #339 first (000090 + collector — the read path depends on
  its table); prod already has the data. Then: apply 000092 on prod (session
  pooler, §1) → merge/deploy this read-path change → post-deploy **revalidate
  sweep** (the `/housing/[state]/[suburb]` pages are ISR
  `revalidate = 86400` with a baked `initialProfileJson`
  (`web/src/app/housing/[state]/[suburb]/page.tsx` lines 13, 59) — without the
  sweep, profiles show no crime section for up to 24h; the client refetch will
  still populate it after hydration since `staleTime` is 1h from the baked
  timestamp).
- Backend `MemoryCache` is in-process → deploy flushes it (no key changes).
- Browser sessionStorage caches (`getHousingClient.ts`) self-heal (§4.3).
- No Upstash KV involvement — the suburb routes don't use the KV layer (only
  `getHousingOverview`/price-drops do).

---

## 6. Tests

- **Go**: no store-interface changes → mocks untouched. Add/extend a handler
  test only if one exists for `ListStateSuburbs` mapping (check
  `services/shorts/internal/services/shorts/` tests); otherwise rely on
  `make test-backend`.
- **Web**: `make test-frontend` (jest). Update `data-attribution.test.tsx` if
  text-asserting. Optionally add a `highlight-metrics` unit test asserting the
  three crime metrics return `null` at rank 0 and a colour at rank 50.
- **Bundle**: `cd web && npm run bundle:budget` (no `shorts_pb` import).

---

## 7. Landmines (read before coding)

1. **The small_pop/unreliable gate** — repeated because it's the failure mode:
   every crime read must be `NOT small_pop AND NOT unreliable` (000092 bakes it
   into the MV; readers re-assert it). Ungated reads paint 399,000/100k tiny
   localities at rank 100 and destroy the feature's credibility.
2. **The MV gating gap is why 000092 exists** — the committed 000090 MV lacks
   `unreliable` + `population`, and prod's hand-applied shape isn't guaranteed.
   Never point new SQL at the pre-000092 MV.
3. **Null-not-zero for uncovered states** — TAS/NT have no source; VIC/QLD/SA/
   ACT aren't ingested yet; WA is licence-blocked. LEFT JOIN + `0`-sentinel +
   `value() → null` + absent `SuburbCrime` message. `pct_rank > 0` is the
   availability test (mathematically guaranteed, §0.2); **never** test
   `rate_per_100k > 0` (a genuinely zero-crime suburb would vanish).
4. **RSC no-function-props** — metrics cross the server/client boundary only as
   the serializable `MetricKey`; `makeScale`/`format` live inside the
   `"use client"` registry (`highlight-metrics.ts`). Never pass a scale or
   formatter from a server page (housing §4 format-key rule).
5. **Prod DDL runbook** — 000092 via Supabase **session pooler 5432** +
   `PGOPTIONS="-c statement_timeout=0"`; DB-before-code deploy order (§5).
6. **CC-BY attribution is a licence condition, not decoration** — BOCSAR + ABS
   CVS/ERP credit must ship with the UI (profile footer §4.4 + map attribution
   §4.5).
7. **Migration-number skip hazard** — `000091` sits on unmerged
   `fix/property-resolver-search`. golang-migrate silently **skips** a
   lower-numbered migration that appears after a higher one has been applied.
   At merge time, re-check `ls services/migrations | sort | tail`; if merge
   order inverts, renumber (precedent: 000083→000084 rename for the
   suburb-banner collision). Prod is hand-applied so the risk is local/dev CI.
8. **Legacy proto is message-less** — do not add these fields anywhere in
   `shorts.proto`; do not add rpcs. `proto_parity_test.go` covers rpc parity
   only.
9. **Interim icons** — `METRIC_ICON` is exhaustively typed; the three interim
   sprite picks (§4.1.5) are required for compilation. Swap when a real crime
   glyph is added to the sprite.
10. **`buf generate` output churn** — commit `sdks/java` with everything else
    or CI fails the clean-tree check.

---

## 8. Genuine forks / deferred (owner sign-off)

1. **Pooled vs single-FY on the profile** (this spec: **pooled-latest**, so the
   profile number equals the map colour and uses the stabilised 2-yr series).
   If the owner prefers the most-recent single financial year on the profile,
   swap the profile query source to the base table with `NOT pooled`
   (one-line change, SQL given in §3.1c) — the rank then reads against the
   single-FY distribution and can disagree with the map. Recommendation: keep
   pooled.
2. **Crime sprite icon** — generate a `crime`/`safety` glyph via the
   housing-icons pipeline (`web/scripts/housing-icons/`, brandbrain icon flow)
   and replace the three interim `METRIC_ICON` picks + the `CrimeCard` heading
   icon. Cosmetic, non-blocking.
3. **Deferred (do not build now)**: per-year trend chart from the single-FY
   series (`pooled=false`, would add `repeated SuburbCrimeYear` later);
   `property_damage` as field 31 + a fourth metric once the CVS anchor
   publishes; tooltip crime line (§4.6); per-state metric availability
   filtering in the "Colour by" dropdown.

---

## 9. Ordered task list (Codex)

Work top-to-bottom; each step compiles/passes before the next.

1. **Migration** — create
   `services/migrations/000092_crime_read_gating.{up,down}.sql` exactly as §1.
   Verify numbering is still free (`ls services/migrations | sort | tail -3`).
   Apply locally: `cd services && make migrate-up` (needs 000090 in the chain —
   if building on a branch cut from `main` before PR #339 merges, rebase onto
   the merged crime branch first).
2. **Proto** — edit `proto/shortedapi/shorts/v1alpha1/housing.proto` per §2
   (SuburbSummary 28–30; new `SuburbCrimeStat`/`SuburbCrime`;
   `GetSuburbProfileResponse.crime = 7`). Run `cd proto && buf generate`;
   commit all generated outputs incl. `sdks/java`.
3. **Store** — `postgres_house_prices.go`: `SuburbSummaryRow` fields + pivot
   join + SELECT + Scan (§3.1a/b); `SuburbCrimeStatRow` + `Crime` on
   `SuburbProfileRow` + `suburbCrime()` helper + call site (§3.1c).
   `cd services && go build ./...`.
4. **Handler** — `house_prices.go`: map the three summary ranks in
   `ListStateSuburbs`; build `SuburbCrime` (nil-when-empty) + fill the embedded
   summary ranks in `GetSuburbProfile` (§3.2). `make test-backend`.
5. **Frontend registry** — `highlight-metrics.ts`: input fields, `MetricKey`,
   `crimeRankScale`, three `HIGHLIGHT_METRICS` entries, `METRIC_ICON` interim
   entries (§4.1).
6. **Frontend plumbing** — `state-suburb-map.tsx` `SuburbDatum` fields (§4.2);
   `state-suburb-explorer.tsx` mapping (§4.3).
7. **Profile section** — `suburb-profile.tsx`: `CrimeCard` + render site
   (§4.4). `data-attribution.tsx` BOCSAR credit (§4.5).
8. **Tests** — `make test-frontend`; update `data-attribution.test.tsx` if
   needed; `cd web && npm run bundle:budget`.
9. **Local verify** — `make dev`. The local DB has no crime rows, so seed a
   fixture first (psql `postgresql://admin:password@localhost:5438/shorts`):

   ```sql
   INSERT INTO suburb_crime_stats
     (sal_code, crime_type, fy_ending, pooled, raw_offence_count,
      adjusted_offence_count, rate_per_100k, pct_rank, population, scale_factor,
      small_pop, unreliable, source_jurisdiction, source, source_licence)
   SELECT d.sal_code, ct, 2025, true, 100, 150,
          200 + random() * 3000, 1 + random() * 98,
          GREATEST(d.population, 2500), 1.5, false, false,
          'NSW', 'bocsar', 'CC-BY-4.0'
   FROM (SELECT sal_code, population FROM suburb_demographics
         WHERE state_code = 'NSW' AND population > 2000 LIMIT 300) d
   CROSS JOIN unnest(ARRAY['break_ins','violent','motor_vehicle']) AS ct
   ON CONFLICT DO NOTHING;
   REFRESH MATERIALIZED VIEW mv_suburb_crime_latest;
   ```

   Then verify in the browser (`lsof -nP -iTCP:3020 -sTCP:LISTEN` first — make
   sure the LISTEN pid is the dev server just started):
   - `/housing/new-south-wales` → "Colour by → Break-ins": seeded suburbs paint
     the yellow→red ramp; unseeded NSW suburbs + the whole map on
     `/housing/victoria` hatch.
   - A seeded NSW suburb profile shows **Crime & safety** (3 tiles, percentile
     badges, FY + BOCSAR/ABS CC-BY footer).
   - A TAS suburb profile (`/housing/tasmania/<any>`) shows **no** crime
     section (and no zeros anywhere).
   - Sanity-gate check: flip one seeded row to `small_pop = true`, re-`REFRESH`
     the MV, confirm that suburb now hatches / loses its section.
10. **Docs** — add the crime rows to `docs/housing-architecture.md` §5.1 table
    + §5.6 metric list + §7 licensing table; add
    `mv_suburb_crime_latest`/000092 to the CLAUDE.md housing migrations line.
11. **Prod rollout (owner-run)** — apply 000092 (session pooler runbook §5),
    merge/deploy, run the revalidate sweep.
