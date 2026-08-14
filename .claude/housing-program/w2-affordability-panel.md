# Wave-2 work package: affordability-panel

Surface the dark national series on /housing: affordability & credit section + retire the frozen RPPI tile

## Ground rules (read first)

- You are in a git WORKTREE of the Shorted repo on your own branch. Commit ALL work there with
  conventional-commit messages. Do NOT push, do NOT merge, do NOT switch branches, do NOT touch main.
- Read docs/feature/housing/README.md + the sibling docs first (they were written 2026-08-09 and are
  the corrected source of truth; the old docs/housing-architecture.md monolith is stale on numbers).
- Non-negotiable repo rules: interactive charts import via dynamic(ssr:false) from "use client"
  modules; never pass functions across the RSC boundary (pass a serializable key and look the
  formatter up client-side); read searchParams client-side (useSearchParams under Suspense) on ISR
  pages - a server-page searchParams read silently forces dynamic; server actions use
  getShortsApiUrl() from app/actions/config.ts; connect transports on ISR pages need the
  next:{revalidate} tag or regeneration throws; KV reads go through the readCached non-emptiness
  predicate.
- Prod DDL is HAND-APPLIED (the CI allowlist contains no housing migrations). Only create migrations
  if this spec assigns you numbers, and state the exact prod apply order in your summary.
- Do not modify .proto files or run buf generate unless this spec explicitly assigns it. If a proto
  change is needed and not assigned, implement what you can without it and note the gap.
- Keep the diff scoped. No drive-by refactors.
- QA before finishing: run the narrowest relevant tests (scoped `go test` for touched packages;
  `cd web && npx tsc --noEmit` plus touched jest suites for web). Report ACTUAL results honestly.
- IMPORTANT - concurrent work: seven sibling branches (feat/housing-{web-suburbs,collector-lifecycle,
  collector-vg,mv-correctness,api-hardening,crawl-correctness,repo-hygiene}) are fixing audit bugs in
  parallel. Do not "fix" those areas; if you must touch a shared file, keep the edit minimal and
  additive so a later merge is clean.
- Finish with a summary: what you built, deliberate omissions, test results, hand-verification needed.

These enhancements come from a 24-agent audit of the housing feature (2026-08-09). Each is grounded
in data or components that ALREADY EXIST - the point is wiring, not greenfield.

## Track notes

This is the highest-value/lowest-risk enhancement in the set: roughly a dozen national
series are ALREADY ingested into house_prices every month and have NO reader at all. Deliverables:
(1) Swap the '8-capital price index (to 2021)' BigStat - which is frozen at 2021-Q4 upstream - for
the live price_index_derived series, and add a chart for it (format='index' is already supported).
(2) Add an 'Affordability & credit' section to /housing surfacing the dark measures: cash_rate,
mortgage_rate_oo/mortgage_rate_investor, housing_credit_growth, price_to_income, rents_index,
wage_index, investor_loan_share, household balance-sheet measures. Use the existing
HousingSeriesChart (it already takes a measure prop) and GetHousePriceSeries (accepts any measure).
(3) Watch the frequency trap: mv_housing_headline is quarterly-only (period_freq='Q'), so monthly
series must come through GetHousePriceSeries rather than the headline MV.
Design constraint: /housing is static ISR - keep it that way. Lazy-load below-the-fold charts
(WhenVisible/dynamic ssr:false) so the bundle budget doesn't regress; run `npm run bundle:budget`
if the route's JS grows. Label every series with its source + licence attribution the way the
existing tiles do.

## Enhancements (verbatim from the audit)

### Surface the ~12 dark national measures as an 'Affordability & credit' section on /housing

**Value:** high · **Est. effort:** M

Exists: runOfficial already ingests mortgage_rate_oo/mortgage_rate_investor (RBA F6, rba.go:118), cash_rate (F1.1), housing_credit_growth ×3 (D1), household_dwelling_assets/net_worth/liabilities (E1), wage_index (WPI), rents_index (CPI, abs_affordability.go:26), price_to_income (abs_affordability.go:84), investor_loan_share and price_index_derived — but the web UI charts only mean_price, debt_to_income and median_price (grep measure= across housing pages → 3 distinct). GetHousePriceSeries accepts any measure and HousingSeriesChart already takes a measure prop. Increment: add tiles + WhenVisible charts (mortgage rates vs cash rate, rents inflation YoY, investor vs OO credit growth, price-to-income) and replace the '8-capital price index (to 2021)' tile — frozen upstream — with price_index_derived, which abs.go:368 explicitly built 'to give /housing a current-quarter index line'.

### Wire price_index_derived into /housing and retire the frozen RPPI tile

**Value:** high · **Est. effort:** S

The current-quarter national + per-state derived index (531 rows, live to 2026-03-31, refreshed monthly) already exists in prod precisely for this — swap the '8-capital price index (to 2021)' BigStat and add a HousingSeriesChart for it (format='index' already supported). Zero new ingest work; pure read-path wiring in web/src/app/housing/page.tsx.

### Rates & credit panel from already-ingested RBA series

**Value:** medium · **Est. effort:** M

cash_rate (432 rows, monthly to 2026-07-31), mortgage_rate_oo/investor (F6), housing_credit_growth ×3 (D1) and the E1 household balance sheet are all in house_prices with no reader. A '/housing' rates panel (cash rate vs outstanding mortgage rates vs credit growth) is a pure frontend + one-RPC job — note mv_housing_headline is quarterly-only (period_freq='Q' filter, 000053:67), so monthly series need GetHousePriceSeries or an MV tweak.

