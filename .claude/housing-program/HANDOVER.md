# Housing feature — audit, cleanup and enhancement program

Prepared 2026-08-10. Everything below is committed on local branches. **Nothing has
been pushed, merged, or applied to prod** — those steps are yours.

## What happened

A 24-agent adversarial audit of the housing feature (2026-08-09) produced 38 findings;
13 of the top 14 were independently confirmed. Fixes were implemented by Codex
(gpt-5.6-sol, high effort), one work package per branch, then put through **two full
adversarial review rounds** — three independent lenses per branch plus a separate
refutation pass. Round 1 found 21 confirmed defects (2 blockers); round 2 found 24
confirmed defects and **zero blockers**.

The two round-1 blockers are worth knowing about, because both were shipped-looking code
that would have produced wrong public data:

- **Crime ranks inverted.** `COALESCE(GREATEST(rank, 0.1), 0)` — Postgres `GREATEST`
  ignores NULLs, so "no data" returned `0.1` instead of `0`. Every suburb outside NSW
  (the only state with crime data) would have painted as *safest* on the map instead of
  showing the no-data hatch. A test had been written that pinned the bug in place.
- **Agency ranking inverted.** NULLing `dropped_count` below the k-anon floor collided
  with `ORDER BY … DESC`, which is `NULLS FIRST` in Postgres — agencies with *no* price
  drops would have ranked above the biggest discounters on `/price-drops`.

Both were reproduced against a real PostgreSQL container before being fixed.

## Branches

| Branch | What it does |
|---|---|
| `docs/housing-feature-docs` | Splits the 75KB monolith into `docs/feature/housing/` (README, data-sources, data-model, pipeline, operations, architecture), mirroring the politicians doc set. Shrinks CLAUDE.md's housing section 99 lines → 34. Corrects drift: 22 collector modes (docs said 7/11), 500-suburb catalog (said 115), 88,689 listings (said ~12k), collector Terraform IS wired (said "not yet"). |
| `feat/housing-web-suburbs` | Repairs the suburb URL corpus: **all 1,165 suburb URLs in the live prod sitemap 404** because the slugifier appended `-${postcode}` while `postcode` is never populated. Also restores ISR on suburb pages (a server-side `searchParams` read was silently forcing dynamic), stops backend blips serving soft-404s, validates the `?sal=` fast-path against the path, removes the dead `/housing/suburbs` cluster. |
| `feat/housing-collector-lifecycle` | Official runs exited 0 even when every source and the MV refresh failed — nothing read `house_price_ingest_runs`, and no freshness sentinel existed. Adds honest exit codes, cursor integrity on failure, and a `housing-freshness` workflow. |
| `feat/housing-collector-vg` | NSW valuer-general medians have **never landed a row in prod**; VIC is pinned to a 2014-2024 workbook and currently 403s. Adds runtime VIC workbook discovery, a residential-rig path for NSW, and never-succeeded loudness. |
| `feat/housing-mv-correctness` | Migrations **000107-000109** plus store fixes: MV refresh hardening (the 000095 pattern never reached housing), k-anon floor, address dedup, sold-window anchoring, headline LAG partitioning, real `politician_property_count`, crime-rank sentinel. |
| `feat/housing-api-hardening` | Kill-switch takedown completeness (KV bypass so a flip takes effect immediately), header-based revalidation secret with `timingSafeEqual`, case-insensitive state codes returning `InvalidArgument` instead of empty-200, one shared cache-key normalizer. **AVM valuations stay ON by default with a kill switch** (your call). |
| `feat/housing-crawl-correctness` | Thin-suburb sweeps were misclassified as Kasada blocks; the first fix then returned "sweep complete" with an *empty* listing set, which would have armed delisting against a whole suburb. Also tightens the brandbrain outbound contract. |
| `feat/housing-repo-hygiene` | Real captured REA/Domain portal markup — addresses, prices, listing ids — was committed in the public repo. Replaces it with synthetic fixtures and adds a CI provenance gate. |
| `feat/housing-affordability-panel` | Surfaces ~12 national series already ingested monthly but **never read by any UI**: cash rate, mortgage rates, credit growth, price-to-income, rents, wages, investor loan share, household balance sheet. Replaces the RPPI tile (frozen at 2021-Q4 upstream) with the live derived index. |
| `feat/housing-price-drops-choropleth` | State choropleth on `/price-drops`, shading by 30-day drop share, preserving the static ISR and the accessible table. |

## Merge order (matters)

Conflicts were probed by trial merge. They are almost entirely mechanical — branches
edited `docs/housing-architecture.md`, which the docs branch turned into a redirect stub.

1. `docs/housing-feature-docs` — **first**, so the doc move settles before anything else.
2. `feat/housing-repo-hygiene`
3. `feat/housing-crawl-correctness`
4. `feat/housing-collector-vg`
5. `feat/housing-collector-lifecycle` — after vg, so the shared `main.go` exit-code
   interaction resolves in one direction
6. `feat/housing-mv-correctness` — **DDL must be applied to prod before this merges**
7. `feat/housing-api-hardening`
8. `feat/housing-web-suburbs`
9. `feat/housing-affordability-panel`
10. `feat/housing-price-drops-choropleth`

Conflict resolution rules:
- `docs/housing-architecture.md` → take the docs-branch stub; port any substantive
  content edit into `docs/feature/housing/architecture.md`.
- `CLAUDE.md` → the docs branch owns the housing section; drop other branches' hunks.
- `postgres_house_prices.go` (web-suburbs vs mv-correctness) → the one genuine code
  conflict; both touched crime ranks. Keep mv-correctness's `displayCrimeRank` helper.

## Prod migrations — apply BY HAND before the code merges

The prod deploy applies a **hardcoded allowlist that contains no housing migrations**,
and force-writes `schema_migrations` to 75. Housing DDL has always been manual.

Apply via the **session pooler (5432, not the txn pooler 6543)** with the timeout off,
one file at a time, off-peak — `000109` does synchronous `DROP`/`CREATE MATERIALIZED VIEW`
rebuilds and the affected read surfaces are unavailable during recreation:

```bash
PGOPTIONS="-c statement_timeout=0" psql "$SESSION_POOLER_URL" \
  -f services/migrations/000095_harden_mv_refresh.up.sql   # audit found this never reached prod
PGOPTIONS="-c statement_timeout=0" psql "$SESSION_POOLER_URL" \
  -f services/migrations/000107_harden_housing_mv_refresh.up.sql
PGOPTIONS="-c statement_timeout=0" psql "$SESSION_POOLER_URL" \
  -f services/migrations/000108_fix_housing_headline_source_lags.up.sql
PGOPTIONS="-c statement_timeout=0" psql "$SESSION_POOLER_URL" \
  -f services/migrations/000109_fix_listing_rollup_correctness.up.sql
```

## After merging

- **Revalidate sweep** — a promote resets ISR pages to placeholders. Run the usual sweep
  (secret from GCP SM `REVALIDATION_SECRET`, browser UA required).
- **Resubmit the sitemap** in Search Console once web-suburbs is live — 1,165 URLs go
  from 404 to 200.
- **Run the NSW valuer-general ingest from a residential rig.** Cloud Run's datacenter
  egress cannot clear the Cloudflare challenge by design; the code now supports the rig
  path, but someone has to run it. This is what unblocks NSW 0/4,544, and it is the
  single biggest data gap in the feature.

## Not done (deliberately deferred)

Wave-3 enhancements, all grounded in data already held, specs in
`.claude/housing-program/enhancements.json`:

- Crawl-derived suburb asking-price medians where VG data is missing (fills NSW/QLD/WA).
- Widen the suburb indexation gate from 1,165 priced suburbs to the ~8-12k rich-profile
  corpus, plus `generateStaticParams` and a KV slug→SAL index.
- Housing embeds + open-data hub entries for the backlink program (ABS/RBA series are
  CC-BY and republishable; crawl aggregates are own-derived).
- Crime beyond NSW (VIC/QLD/SA/WA all publish open offence tables; the pipeline is
  already state-pluggable).
- Time-anchored sold-price layer → asking-vs-sold discount per suburb, which no free
  AU site publishes.

---

## Integration result (2026-08-10)

All ten branches are merged into **`integration/housing-trial`** and verified:

- `198 files changed, +14,734 / −2,334`
- `go build ./shorts/... ./house-price-collector/ ./jobs/...` — **OK**
- `npx tsc --noEmit` (web) — **EXIT=0**
- No conflict markers anywhere in the tree.

Three conflicts needed real resolution (the rest were the mechanical docs move):

1. **`deploy/README.md`** — the crawl-scheduler rewrite and the new NSW VG section
   both wanted the intro. Kept both.
2. **`main.go` / `job.go`** — the two collector branches had incompatible exit-code
   designs (`refresh()` vs `refresh() error`; `runOfficial(jobs)` vs
   `runOfficial() (total, failures)`). Composed into one contract that keeps the
   lifecycle failure policy AND the VG freshness gate, while preserving the rule that
   a source this environment deliberately doesn't run (`vg_nsw` on Cloud Run) never
   makes the job exit non-zero.
3. **`postgres_house_prices.go`** — web-suburbs' `preferredSuburbRegionJoin` subsumes
   mv-correctness's inline LATERAL and adds licence-correct source preference, so the
   LATERAL was dropped and the join kept, alongside mv-correctness's politician count
   and the `sql.NullFloat64` crime-rank handling.

## Commands for you

Everything below needs your hands — the harness blocks me from pushing/merging, and
prod DDL is a live write.

**1. Push the branches** (from `~/projects/shorted`):

```bash
for b in docs/housing-feature-docs feat/housing-repo-hygiene \
         feat/housing-crawl-correctness feat/housing-collector-vg \
         feat/housing-collector-lifecycle feat/housing-mv-correctness \
         feat/housing-api-hardening feat/housing-web-suburbs \
         feat/housing-affordability-panel feat/housing-price-drops-choropleth; do
  git push -u origin "$b"
done
```

Or push the single pre-merged branch instead, if you'd rather review one PR:

```bash
git push -u origin integration/housing-trial
```

**2. Apply the migrations to prod BEFORE merging mv-correctness** (see the psql block
above). `000109` rebuilds materialized views synchronously — run it off-peak.

**3. After the deploy**: revalidate sweep, resubmit the sitemap, and run the NSW
valuer-general ingest from a residential rig.
