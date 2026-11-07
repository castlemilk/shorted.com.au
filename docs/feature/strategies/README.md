# Strategies: the stock picker, signals, backtests and saved strategies

Moved out of `CLAUDE.md` on 2026-11-07 so the session context stays small. `CLAUDE.md` keeps the rules that shape every change here and points at this file; the full record lives here. Keep the two in step: a new landmine goes HERE, and only a rule every session needs goes in `CLAUDE.md`.

Specs: `brief.md` (the URL move), `docs/plans/stock-picker.md`, `docs/plans/fundamentals-coverage.md`.

## Stock picker (`/strategies`, strategy-driven shortlists)

The route lives in `web/src/app/strategies/` (moved from `app/picks` by the URL move in `docs/feature/strategies/brief.md`). Every
`/picks` URL answers 308 to `/strategies` through `web/src/config/strategy-redirects.mjs`.
`components/picks/` and `public/picks-art/` keep their names: they are not routes.

`/strategies` hub + `/strategies/[strategy]` (ISR 3600, static params from
`web/src/@/lib/strategies/registry.ts`) over `StrategyService`
(`strategies.proto`: `ListStrategies`, `GetStrategyPicks` with `sort_by` /
`require_fundamentals`, `GetStockStrategyFit`) and
`StockService.GetStockFundamentals` (periods, `growth`, `quality`, `coverage`,
`latest_filing`). Five strategies ship: `zanger-breakout`, `canslim`,
`minervini-trend-template`, `crowded-short-breakout`, `quality-compounders`.
Every rule evaluates to **pass / fail / unknown**; unknown (missing data, or a
ratio not meaningful for the company) never counts as a pass and blocks status
`triggered`. Contracts: `docs/plans/stock-picker.md` (picker, strategies) and
`docs/plans/fundamentals-coverage.md` (full statements, filings, quality,
valuation, stock page).

| Piece | Where |
|---|---|
| Strategy prose, rules, weights, evaluator, sort, valuation, financials rule (no DB) | `services/pkg/strategy/engine/` (prose lives HERE once; the evaluator moved from `services/shorts/internal/strategies/` in 2026-11; `services/pkg/strategy/instrument/` holds ClassifySecurity; `engine/version.go` is the engine version; the web registry holds SEO metadata only) |
| Rules spec: the versioned rule set as data, canonical JSON, `rules_hash`, the v0 registry (`Registered`: Changes, KnownIssues, Recipe, nil on v0), rule prose templates, the execution recipes (the five r1 recipes, their validation, canonical hash and printed lines) | `services/pkg/strategy/spec/` (`spec.go` types, `canonical.go` and `RulesHash`, `registry.go`, `v0.go`, `prose.go`, `recipe.go` (`Recipe`, `Validate`, `RecipeHash`, `R1Recipes`, `RenderRecipeLines`, `RecipePreface`); pinned goldens in `spec/testdata/spec_hashes.golden`, `recipe_hashes.golden` and `recipe_lines.golden`). The rule prose templates in `prose.go` are not served yet: served evaluation and author prose still come from the engine until a later version generates them from the templates. Engine output golden: `engine/testdata/evaluate.golden`, with `engine/testdata/version_history.golden` |
| `quality-compounders` (house, no regime gate) | core `roe` (>= 15%), `net_margin` (>= 10%), `cash_conversion` (FCF > 0 and >= 0.8x NPAT), `leverage` (net cash, or net debt / EBITDA <= 2.5), `liquidity`; trigger `above_sma200`; non-core `revenue_not_shrinking` |
| `sort_by` | `score` (default, rank order), `revenue_yoy`, `eps_yoy`, `roe`, `net_margin`, `fcf_margin`, `pe` (ascending), `market_cap`; unknowns last, growth outside [-95%, +500%] after every measured figure; `rank` stays the evaluator's; any other value is `InvalidArgument` |
| Score (`weights.go`, `proximity.go`) | A pass earns weight x (0.6 + 0.4 x strength) x 100; a FAILING trigger rule (`Strategy.TriggerRules`: breakout, near_high / off_high, rs_leader, above_sma200) earns weight x 0.3 x proximity x 100, proximity 1 at the trigger line and 0 at the rule's far distance (10% under the pivot, 15 / 25 points under the 52-week lines, 20 RS points under the quartile cut-off, 10% under the 200-day), so setups rank nearest-to-firing first (2026-10-21). 0.3 < 0.6 keeps a near miss below a floor pass; a triggered score is untouched. Every trigger rule's evaluation prose ends with `evalTriggerCredit` (`TestTriggerRuleProseStatesTheCredit`) |
| Art (scenes) | `lib/strategies/scenes.ts`: one generative scene per strategy, the glyph's mechanism at scene scale (the weir, the staircase, the fan, the coil, the meter), as a pure `sceneFrame(slug, w, h, t)` of SVG paths in the theme's tones (ink, amber, olive, rust, muted; never market red or green). Drawn three ways from the one geometry: the SSR'd inline-SVG still in the ISR HTML (`components/picks/strategy-scene.tsx`, `SCENE_STILL_TIME` picks the strategy's moment), a Canvas 2D animation layered over it in the browser (`strategy-scene-canvas.tsx` via the lazy client module: a few KB, no three.js; 30 fps cap, paused off-screen and on a hidden tab, nothing under reduced motion, theme colours re-read from the CSS variables; `data-scene-live` on the host fades the still out), and the strategy OG card (`OgCard.scene`). The scenes answer the pointer (`ScenePointer`, eased per frame, read on the nearest `data-scene-stage` ancestor: the strategy header section and the hub row's article, so a pointer over the H1 plays the scene behind it; touch is a tap, nothing is prevented): past the base the hand pulls Zanger's plume over the pivot, the CAN SLIM marker walks to it, price lifts under it on the fan and the fan opens for a high hand, the coil compresses under a pressing hand and releases when it leaves, the needle swings to it on the dial. The still and the OG card never see a pointer. The two scene files are the ONLY `use client` modules in the kit (`client-boundary.test.ts`). The scenes are the one place the desk loops; they are decorative, aria-hidden and behind a scrim |
| Art (brandbrain) | `web/scripts/picks-art/`: one warm-duotone scene per strategy (the glyph's mechanism at scene scale) through the brandbrain flow-orchestrator MCP (`web/scripts/lib/brandbrain-flow.mjs`, the ONE shared driver) or the OpenAI fallback; `bake.mjs` writes `public/picks-art/<id>.{light,dark}.avif`, `og/<id>.jpg` and the manifest `lib/strategies/art.generated.ts` (slug -> content hash; empty until baked). `strategyArt(slug)` is null without an entry and the generative scene is shown instead (`hasStrategyArt`): the strategy header is a bordered band on the art (`StrategyArtBand`), the hub row has a 3:2 plate column (`StrategyArtPlate`), the strategy OG card takes the JPEG as `backgroundSrc` (over the scene). Run it locally (the MCP and its login live on the owner's machine), commit the baked files with the manifest |
| Store | `store/shorts/postgres_strategies.go`, `postgres_fundamentals.go` (the growth and extras reads are `pgsource`'s, which the store delegates to with the 42P01/42703 tolerance unchanged): a missing view = empty universe; a schema without 000132 (42P01 / 42703) = nil quality, provenance and coverage, never a 500 |
| Data: `stock_fundamentals` (+ `_sync`), `mv_fundamentals_growth` | `000129`, widened by `000132` (below); `000155` adds the vintage trigger (landmine below) |
| Data: `stock_fundamentals_vintages` | `000155`: one row per insert (`I`), changed update (`U`), delete (`D`), plus a one-time baseline (`B`), written by trigger `trg_fundamentals_vintage`. Kept forever, never pruned |
| Data: `asic_report_ingests`, `shorts_revisions` | `000155`: written by `shortdatasync` (daily, poll, reconcile), never by a trigger, so `shorts` (2.1M rows) gains none. `loaded_rows >= file_rows` is the report-completeness rule; a zero-code file records `file_rows` NULL |
| Data: `mv_price_features`, `mv_market_regime`, `refresh_strategy_views()` | `000130`; refreshed by `shorted picks -mode refresh` weekdays 13:30 UTC, AFTER the price sweep (not inside `refresh_all_materialized_views()` at 10:00, which runs before prices land). Order: regime, growth, quality, price features. The step pins `client_min_messages = notice` and fails on a `Skipping <view>` warning or on a picker view with no `Refreshing <view>` NOTICE (a stale 000130 body: re-apply 000132) |
| Data: `000132_extend_fundamentals` | 21 statement lines on `stock_fundamentals` (gross profit to current liabilities; outflows negative); `field_sources` JSONB (only fields NOT from the row's `source`: Markit, a filing, `derived:*`); `source_document_url` / `_date`; `period_type='quarter'` = a balance snapshot (no flow fields); sync `last_outcome`, `consecutive_empty`, `median_k`, `fx_converted`, `native_currency`; `picks_run_lease`; `financial_report_extractions.document_meta`; growth view rebuilt once with `revenue_basis_source` / `eps_basis_source` (`vendor` / `filing`) and `revenue_latest_period_end` / `revenue_prior_period_end` appended; new `mv_fundamentals_quality` (one flow row + one same-currency balance row at or up to 6 months before it) |
| Job | `shorted picks` (`services/jobs/README.md` "picks"): `-mode all` daily 15:00 UTC (fundamentals, filings, refresh; 12600s timeout, 1 retry). Fundamentals is budget-driven, no count cap: `PICKS_FUNDAMENTALS_BUDGET_MIN` 170 at 4s/code, priority due filers, never attempted by market cap, failures, stale successes (14-day skip, 45 for repeat empties); pre-000132 sync rows (`last_outcome` NULL) queue with never attempted and are never skipped, so the first nights after the deploy re-fetch the universe largest first (`pre_000132=N` in the log); breakers at 25 consecutive failures, >30% of the last 100 Yahoo requests, Markit off after 10; 20-minute budget on a task retry. One writer via `picks_run_lease` (a held lease exits 0). After a refresh: waits 16 min, then revalidates tags `strategy-picks` (+ `fundamentals` when rows changed) |
| Parity shadow | `shorted strategies -mode parity` (read-only) and, after each live weekday `-mode refresh`, a log-only comparison when `STRATEGY_PARITY_SHADOW=on` (Cloud Run picks job and both CronJob twins). Holds fs1 to `mv_price_features`, the regime to `mv_market_regime` and sf0 days-to-cover to 000080's `latest_shorts`/`avg_volume` CTEs, inside one REPEATABLE READ transaction. Log line `strategy_parity ... conclusive=<bool>`; inconclusive unless the newest price sweep completed before the refresh began. Never changes the picks exit code; never runs in `-mode all`. Code: `services/jobs/internal/jobs/strategies/`; README "Parity shadow" |
| Filings | `financial-report-extractor` (Python, `services/report-extractor`, `module "report_extractor"`): daily 14:00 UTC, `--recent 2 --limit 360 --workers 4 --max-pages 8 --budget-min 90` (360 since 2026-10-11; 917 companies had an unread results document), 7200s, no retries. **Backend `openrouter`** (`direct_extract.py`, since 2026-09-29): one call per document, DeepSeek v4 Flash primary + Gemini 2.5 Flash-Lite checker, Gemini 2.5 Flash arbitrates disagreements (no majority = withheld); every figure deterministically validated (quote located in the document, value in the quote, label keywords per metric, unit scaled to true millions); underlying/diluted figures stored as `underlying_*`/`diluted_eps`; `consensus` + `models` attributes on every entry; benchmark with `bench_direct.py` / `bench_gold.py` before changing the prompt. `--backend gemini` keeps the old langextract path. `director-trade-extractor` runs the same consensus over Appendix 3Y notices (`director_direct.py`: name and every number must be in the notice; a per-share price is multiplied in code; one consideration box over several lots, or over shares plus options, gives no value; a direction contradicting the stated nature is invalid); a failed model call is `model_error`, never recorded as an attempt (the old path recorded it as `no_extract` and skipped the notice for 30 days, which hid a total outage from 2026-07-30); score rule changes with `bench_director.py`. ONE statutory results document per company (filed within 45 days newest first, then companies with no parsed filing or an unread newest document by market cap, then the rest); a document ASX lists under several codes (a renamed company's old and new code, one report for several funds; 4,101 on 2026-10-11) is read once, under its owner (`choose_document_owners`: prices within 7 days of the newest, then ASIC's short report within 30, then market cap, then the code; market cap alone picked the old code for 591), and each run first moves an extracted row filed under an out-of-date listing to its owner (`rehome_shared_extractions`; 290 rows on the first run, e.g. Swift TV's results from SW1 to STV); an EMPTY extraction (no metrics and no usable digest, i.e. none, or confidence missing or under 0.6, the latest-filing gate, the only reader of a row without metrics; a text layer; `extraction_attempts`, migration 000136) is read again at most twice, 7 days apart, at up to 24 pages, after every first attempt in every tier (ranked within its own tier, 121 retries once sat ahead of CBA's unread full year); `task data:review` lists what is still unread, empty or withheld (`.claude/skills/data-review`); the results classifier (both languages, one fixture) also rejects notices ABOUT a result or report (dates, timing, call details, delays, extensions, dispatch, addenda, additional ASX information, clarifications, letters to holders), while re-lodged corrections stay results documents; an extraction not aligned to the document, or whose value's digits are not in the aligned span, is dropped; thinking off; writes `document_meta` (`report_kind` `other` only from the document's own heading). A model failure is never stored (no row, retried next run), 5 in a row stop new work, and the run exits 1 when its model errors look systemic (5, or at least 3 making up at least a fifth of the model calls). `--repair-echo-digests` is the one-off post-deploy repair of digests written from a few-shot echo; `--repair-document-meta` the one after a change to where `document_meta`'s entity or period is read from (no model call, no key). The only source of ASX half-year totals. Read by `-mode filings` |
| Stock page | Financials tab (`components/stocks/financials-tab.tsx`): Latest result, Key ratios, the statements island (`financial-statements.tsx`, the ONLY `use client` file there), the reports list (the source filing marked), the tax card LAST. Overview: `StrategyFitStrip` (one row per strategy, SSR, names link to `/strategies/<id>`, hidden when the fit call fails; the full readings are the Strategy tab, see "Stock page (one route per tab)" below) and `FundamentalsSummary` (crawlable prose, omitted without coverage) |
| Picker web | `components/picks/`, `lib/strategies/`: the Score column is a `ScoreMeter` (a recessed hairline track with an amber fill the length of the score, md+), the Pivot cell prints the close against the pivot (`pctVsPivot`, muted, never red or green), and each hub row carries a `StatusTape` (one band divided triggered / setup / watch over the ranked rows) under its readouts; a native `<details>` row detail (ratios, basis, source, "Full financials": a followed link to the indexable `/shorts/<code>/financials`, prefetch off), `?status=` and `?sort=` via the `picks-sorted-view.tsx` island (both POST to the rewrite; the shortlist's rows stand in while it loads), coverage "fundamentals for N of M stocks (growth figures for K)" only when `fundamentals_rows_count` is reported. The desk (2026-10): five bespoke strategy glyphs as path data in `lib/strategies/glyphs.ts` drawn by `strategy-glyph.tsx` (non-scaling 1.5px stroke, 1.75px at 40px; the only 56px bezel on a view is the strategy page header, which engraves itself on load); the hub is ONE hairline-divided rack (`<ol>`), never a grid of identical cards; the regime banner carries an aria-hidden, text-free ladder (`ladderMarks`) whose legend is the four readouts; statuses are square lamps, rule outcomes round dots. Motion is `phosphor-warm`, `needle-settle` and `trace-draw`, all `motion-safe:`, and the strategy scenes' canvas loop (above), which is the only loop |
| Feature pipeline (PR-09a) | `services/pkg/strategy/features/`: `price.go` `AsOf` is the exact Go port of `mv_price_features` (000130) evaluated at any session D; `regime.go` `Regime` ports `mv_market_regime`; `seams.go` declares the value types the seams name. `pipeline/` (`Inputs`; `CandidateAt` and `BuildCandidates` are implemented in PR-09c) and `snapshot/` (`Row`, `Features` with ex_div, fs1, sf0, sf1) are seams, not yet readers. Container parity: `features/parity_pg_test.go`, untagged and opt-in (`FEATURES_PARITY_TESTCONTAINERS=1`, `make test-strategy-parity`), run by `task check`'s testcontainers leg and by terraform-deploy run-tests. Anchors 2024-01-31, 2024-02-29, 2024-05-31, 2019-04-23 and the real date; fixtures in `testdata/parity/` |
| Feature pipeline (PR-09b): calendar, short readings, days to cover, corporate-action suspects, ordinary universe | `services/pkg/strategy/calendar/` (strategy sessions = XJO bars intersected with ASIC report dates up to the newest report; a report is public the lag-th session after it, the lag a parameter of `New`), `features/` (`ShortReadingV0` = sf0 with no age limit, `ShortReadingV1` = sf1 over the newest complete report at any age, stale past the maximum age, `DaysToCover` / `DaysToCoverV0` (the bars are `stock_prices` rows unfiltered: `DaysToCover` and `CASuspects` drop the closes that fail `validPrice`, `DaysToCoverV0` keeps them as 000080 does), `CASuspects`), `instrument/` (`IsOrdinary`, `IneligibleReason`; the ETP set from `ownership_funds` fund types etf/lic). Pure: no I/O. The strategy calendar is NOT `asxcalendar` and must not leak into the public history API, which keeps `asxcalendar`. Intersecting the two date sources errs toward a later availability date, so a missing session only delays a figure. Open: report age is counted on the intersection calendar, so a gap in ASIC reports shortens it and a stale report can read as current until the spec owner decides. Index dates: the index sync dates each bar by its ASX session (Sydney date, #860), and the one-off full-history re-fetch ran on 2026-11-05 (every XJO, XAO, XKO and XJT row re-dated; no weekend rows left), so `calendar.New` reads exchange dates. `TestShiftedIndexDatesOnlyDelay` still pins that a shifted index date can only delay a report's availability, never advance it. |
| Feature pipeline (PR-09c): `pgsource` readers and `BuildCandidates` | `services/pkg/strategy/pgsource/` (pgx readers shared by the API and the jobs): `Bars`, `IndexBars`, `ASICRows`, `ReportIngests`, `ETPSet`, `CompanyNames`, `Metadata` (name, industry, logo, the guarded `key_metrics` market cap; `MergeMetadata` attaches them, and the industry must be attached before `engine.PrepareCandidates`), `Dividends` (ORDER BY stock_code, ex_date, dividend_type, amount: a total order for ex-dates shared by a final and a special), `CashRate` (monthly; each point carries the latest rate observed strictly before its first day, so no point reads a rate set in its own month; a month with no earlier observation has no point), `ListGrowth` / `GetGrowth` / `ListExtras` / `GetExtras` / `Fundamentals` (moved verbatim from the store). Tolerance: the fundamentals reads treat 42P01 and 42703 as absent; `ListGrowth`, `GetGrowth`, `ReportIngests`, `ETPSet`, `CompanyNames`, `Metadata` and `CashRate` treat 42P01 only; `Bars`, `IndexBars`, `ASICRows` and `Dividends` treat neither. A NULL price, position or count is NaN; a NULL volume reads as 0, as 000130 does. `pipeline.CandidateAt(code, t, in, s)` and `BuildCandidates(D, in, s)` take the version because the rules are the version's: the checks run in order (bar on session, history, instrument, corporate-action guard, short report membership), and the guard holds a code out for `pipeline.CAGuardSessions` (260) sessions counted from the suspect's bar, from its known date. Container suite: `make test-pgsource-pg` (`PGSOURCE_TESTCONTAINERS=1`, `services/pkg/strategy/pgsource/readers_pg_test.go`), gated in terraform-deploy run-tests and `scripts/local-verify.sh` beside the parity suite. `IndexBars` returns XJO/XJT rows dated by ASX session (#860; the full history was re-fetched on 2026-11-05). `PriceCandidateAt(code, t)` (PR-14b) is the index method giving an excluded code its price features (DV20, SMAs, pivot) as of its last priced bar on or before t, whatever the universe decides. The PR-10 daily snapshot reads them under the gate in its landmine above. |
| MCP | `list_strategies`, `get_strategy_picks` (`sort_by`), `get_stock_fundamentals` (`quality`, `coverage`); no new tool |
| Backtest step (pure, no caller yet) | `services/pkg/strategy/backtest/`: `Step` fills at the next traded open with the recipe's cost model, marks on the per-bar total-return basis (a 2-dp payer priced A$1-2 stays total return; the quantum switches at the 4-decimal date), credits cash dividends only on unadjusted bars to the holders at the previous close (a cash-credited bar takes no k step, so its dividend is not counted twice), prices each bar's rounding at its own date's quantum (the first 4-decimal bar carries the previous cents bar's rounding), applies the corporate-action exclusions (a queued exit on the suspect bar waits, and a corroborated suspect is acted on at the open of its publication day) and stale exits. Only `CAGR` (365 days) and `Sharpe` (126 returns) are window-gated; `Summarise` and `MaxDrawdown` report on any window. Nothing outside the package reads it yet |
| Backtest run (pure, no caller yet) | `services/pkg/strategy/backtest/run.go`: `Run(in Inputs, s, r)` makes two passes over the rows. Pass 1 reads every code on every evaluated session (from the session before the recipe's `window_start`) for the eligible universe's rs_6m values and the regime. Pass 2 evaluates each code through `pipeline.Index.CandidateAt` (the built form of `CandidateAt`, the same checks) and `engine.EvaluateOne`, keeps the codes that ever trigger, and `Step` runs session by session over them. `Inputs` is an interface: `MemoryInputs` holds the rows in memory (the golden dataset and tests); the pgsource reader is PR-16a's. The output hash covers records, events and trades. Gates: `golden_test.go` (the seeded dataset committed as CSV under `testdata/golden`; regenerate only with `go test -args -update` after an engine or recipe change, and `TestGoldenDataIsReproducible` holds the CSV to the generator) and `gates_test.go` (order independence, idempotence, future perturbation with adjusted closes, publication timing, the snapshot equality on every code's pick, rule results and rs_6m statistics, a trading day with no ASIC report, the corporate-action guard's corroboration and point-in-time rules, a corroborated consolidation exited on its publication day, a suspect older than the entry block, and the up-jump after the re-sync). Coverage, the same-data reference, sensitivity and identity hashes are PR-14c. Until the one-off index re-fetch has re-dated the older history (Precondition above), a run over stored index bars is not a production figure PR-14b row rules: an admitted code whose stock rules all fail reads none with score 0, keeping its pivot, DV20, SMAs and breakout date; an excluded code carries `PriceCandidateAt` features whenever its history reads, so a corporate-action or recipe exit decided on its session is charged its real spread tier (a stale exit is charged on the position's entry volume). `TestFillsPayTheirRealTier` recomputes each trade's entry fee from its entry row, takes the exit fee as the rest of `Fees`, and fails unless that exit fee is the fee of the basis the simulator charges (the exit row's dollar volume for corporate-action and recipe exits, the entry's for delisted, suspended and barless time-stop exits), or when that basis falls in the lowest tier. The snapshot gate must reach the admitted-but-not-held branch on the golden data (GD24 is that code, never a pick). |
| Viewer depth | `GetStrategyPicks` is one answer to every HTTP caller. With `STRATEGY_PUBLIC_SIGNALS_LIMIT` set (Terraform `strategy_public_signals_limit`, default 0 = off) every HTTP caller (API tokens included) gets the top N rows of the default ranking, and any offset other than 0 is refused with `X-Entitlement-Detail` (`full_signal_list`). Production sets it to 10 (PR-06b). Signed-in depth is the private `GetViewerStrategyPicks` (bearer token; `viewer` says `free` or `premium`). The depth is read after the cached evaluation, never in its fill. MCP reads take a verified token through `viewerctx.WithMCPUser` (in-process only) |
| Rules versions | `services/pkg/strategy/spec` (`Registry`, `Live`, `RulesHash` = sha256 of the canonical JSON); served from code by `GetStrategyVersion` and `ListStrategyVersions` (canonical only; an unknown hash is NotFound). Every strategy, picks response and fit names its live version (`StrategyVersionRef`, `StrategyFit.version_hash`); the MCP tools print it as `rules_version`. The version chip sits in the strategy header and provenance line and links to `/strategies/changelog` (ISR, indexable, v0 with its known issues). Add a version by appending a `Registered` entry, never by editing a published one |
| Strategy alert rule language (no DB, no clock): condition catalogue, validation, three-valued evaluation, arming and cooldown state machine, first-evaluation state forms | `services/pkg/strategy/alertspec/` (pure; sessions are caller-supplied ordinals; no caller yet, the alerts job and preview arrive in later PRs) |

**Workspace sub-nav (`app/strategies/layout.tsx`).** The Explore / My strategies /
Signals / Alerts bar is `WorkspaceSubNav` (`components/workspace/`, shared with the
ownership workspace), rendered by the client island `components/strategies/strategies-sub-nav.tsx`
from the registry `lib/strategies/workspace-nav.ts`. Only enabled tabs render: My
strategies is on; Alerts ships later. Signals links to the strategy the route is on, or else to the last strategy viewed
(localStorage in try/catch, default `crowded-short-breakout`); the server knows the first from
the path, so the cached HTML is right without storage. The bar's accessible name is
`Strategy workspace`, apart from the in-page switchers also named Strategies. On a
strategy's own routes the bar does not stick, so the profile tab bar is the one sticky
bar. Every enabled href is held to its page by `lib/strategies/__tests__/workspace-routes.test.ts`.
The changelog's version anchors use `scroll-mt-[124px]`, which clears the sticky chrome.
The layout reads no request data. The bar marks the page's own tab
`aria-current="page"` (`currentStrategiesTab`: Explore on `/strategies`, Signals on a signals page) and,
when the page sits in a section rather than on a tab (a changelog or a profile under Explore),
marks that section tab `aria-current="location"`; ownership passes no `currentTab`, so its markup is unchanged.
The Gamma stylesheets are not imported by the layout yet: the first PR that renders a Gamma component
on /strategies adds `gamma-bridge.css`, `gamma.css` and `DataTable.css` to `app/strategies/layout.tsx` and nowhere else.

**Profile shell (`/strategies/[strategy]`).** `[strategy]/layout.tsx` owns the
params (`generateStaticParams`, `dynamicParams = false`, so an unknown slug is a
routing 404) and renders the breadcrumbs, `components/strategies/strategy-header.tsx`
(registry-only, reads nothing) and `components/strategies/strategy-tab-nav.tsx`
(the client tab bar: intent prefetch, `scroll={false}`, dock-on-switch; the kit's other client module,
`strategies-sub-nav.tsx`, links with `scroll` and has no dock). Tabs live in `lib/strategies/strategy-tabs.ts` and render only
when `enabled`; capability flags in `lib/strategies/capabilities.ts` are all off
until their capability ships, so no Compare, Create alert or Alert-me control
renders before then. The Overview page keeps `StrategyPanel` unchanged.

**Signals tab (`/strategies/[strategy]/signals`).** The stock-by-rule matrix:
one column per core rule, each cell a pass, fail, unknown or waiting mark with
its word, and the evidence panel for the selected stock. ISR like the profile
(the layout's params, `?sel=stock:<CODE>` read client-side under `Suspense`),
`noindex, follow`, and listed in `STRATEGY_ROUTES` (`web/scripts/route-kinds.mjs`)
and `isr-pages.json`. It reads the same ranked read as the Overview but shows
only the first `SIGNALS_PUBLIC_ROWS` (10) rows to an anonymous visitor; the
status chips and the count line read the API's `status_counts`, so the rest of
the list is counted, not fetched. The panel's stock reading comes from the
public `getSignalStockFit` action, one call per selection, with the code checked
on the server. Its chart is `StrategyLevelsChart` with `keepVolumeOnNarrow`,
because the panel is narrow on every breakpoint. Measures print the comparison
that holds (`−5.7% < −5.0%` for a failing rule), never a false one. No Alert-me
or Create-alert control renders: those capabilities stay off.

**Rules tab (`/strategies/[strategy]/rules`).** The numbers the live rules
version tests each stock with: one row per rule, with its role, its weight as a
share of the score and its parameters all read from the live version
(`GetStrategyVersion`: the role and weight from its canonical spec, the
parameters from its parameter list) and its title from `ListStrategies`; the
universe and data policy; and this strategy's changelog entries. It is ISR, indexable, listed in
`isr-pages.json`, the sitemap and `STRATEGY_ROUTES`. It never repeats the rule
wording (the Overview's `StrategyPanel` owns it), and it renders no Edit a copy
control until the `variants` capability ships. The recipe lines wait for the
recipe fields on the wire (PR-12a).

### Landmines

- **A view change needs its Go port and its parity fixtures moved together.** `features.AsOf` and `features.Regime` port 000130's `mv_price_features` and `mv_market_regime`, and the parity suite reads the view text from 000130 itself. Redefining either view in a new migration without the port fails the suite; changing the port without the view fails it too. Products that feed a comparison (dollar volume, the RS subtraction) carry an explicit `float64(...)`: arm64 fuses an unrounded `a*b+c` and amd64 does not, so the stored value would depend on GOARCH. The index tolerance is seven days at each end of the RS lookup.
- **Fundamentals are in the company's REPORTING currency** (BHP is USD) and
  growth compares like spans only: a year on the year before, 12 months on the
  12 months a year earlier, a half on the same half a year earlier. Yahoo has NO
  half-year totals for ASX companies; halves come only from filings. `*_yoy_pct` is NULL when a side is missing or the prior
  is <= 0, and every nullable number travels with `has_*`. Never COALESCE an
  unknown to 0 (the screener MV defect the MCP tools paper over).
- **FX-converted vendor statements.** Yahoo converts some codes' statements,
  EPS included, and its currency labels for them cannot be trusted (XRO's
  FY25 EPS 1.3541 is AUD-converted NPAT over shares; the NZD figure is ~1.49).
  A fractional value on an integral line sets `stock_fundamentals_sync.fx_converted`,
  every monetary and per-share Yahoo field is rejected (shares kept), Markit
  supplies native revenue/NPAT, filings supply native EPS, and valuation
  withholds P/E and P/B on the flag itself, not only on the currency label.
- **Price-based ratios need AUD statements AND one ordinary share per listed
  unit.** A stock is valued only when `median_k` sits in [0.8, 1.25], or,
  without one, every computable k = NPAT / (EPS x shares) does. `listed-unit` only on
  positive evidence (`median_k` out of band, or without one any positive k
  outside [1/3, 3]): a CDI (RMD, k ~10) gets no market cap, P/E or P/B, never
  a number 10x off. Anything else (no k, a k <= 0, or a recent issuer's k
  between the bands) is
  `no-shares`, and the picker falls back to the screener market cap. A CDI's
  filing EPS is withheld too (`-mode filings` gate 8, stricter: without a
  `median_k` any vendor k outside [0.8, 1.25] withholds it).
- **The engine's constants and the v0 spec are pinned together.** `engine.TestV0SpecMatchesCode`
  holds `spec/v0.go` to the engine's thresholds, weights, far distances and units (the compares are pinned only for the two moving-average rules), and
  `spec.TestFS1ParamsMatchMigrationLiterals` holds the fs1 parameters to the literals of 000130 and
  000080. A threshold or weight change is a new rules version with a changelog entry, never an edit
  to v0 (its hash is published). A rules-only golden change does not bump the engine; an engine
  output change does (`engine.TestEngineVersionBumpedWithGoldens` over `evaluate.golden`).
- **The five r1 recipes are frozen as committed.** `spec.R1Recipes` (`spec/recipe.go`) is the
  execution recipe each strategy's backtest trades, and `spec/testdata/recipe_hashes.golden` pins
  their hashes. A change to a recipe value or to the `Recipe` layout is a new recipe id, never an
  edit: `TestRecipeHashesArePinned` must not be satisfied by regenerating the golden in place, and
  the golden only gains lines. `TestRegisteredRecipesArePinned` holds any recipe a registered
  version carries to the same rules. Recipe prose is not hashed; it changes only with
  `recipe_lines.golden`, and every recipe surface opens with `RecipePreface`.
- **Financials are decided once, in Go** (`services/pkg/strategy/engine/fundamentals_quality.go`):
  banks, insurers and lending financial-services companies get the
  not-meaningful ratios nulled and listed in `not_meaningful`, so
  `cash_conversion` / `leverage` read unknown (never pass) and they rank watch
  at most. Every surface reads that list; do not re-derive it.
  `statement_is_financial` (TRUE = neither operating income nor EBITDA) is
  read from the newest FULL Yahoo income statement (pretax income present,
  revenue and NPAT its own), never from a Markit, filing or legacy row (those
  never carry either line, which once made BHP, CSL and FMG read as banks);
  NULL means the industry decides. Banks and other financials get a
  Go-computed ROE: the view's 10% equity-to-assets guard applies only to
  non-financials.
- **Parsed filings once published the prompt's own few-shot example** (revenue
  $5,142m, NPAT $1,823m, EPS 94.2c) as BHP, CBA, DRO, EDV and MSB results.
  `services/pkg/extractiontrust` is the ONE funnel (grounding, the few-shot
  denylist by TEXT never by value, provenance strip, `IsResultsDocument`) and
  every reader of `financial_report_extractions.metrics` goes through it:
  picks filings, `GetStockFinancialHighlights`, `latest_filing`, the
  weekly-report collector, the digest prompts. A new reader must too. The
  entity check is one rule too (`extractiontrust.EntityMatches`). The reader
  re-applies the entity NAME rules (`cleanEntity`) to every stored row, but
  WHERE in a document its entity and own period are read from is decided at
  extraction (VIT's own 4E was stored as "Cortexa Pty Ltd", from its control
  gained or lost section, with its prior year's period), so after such a rule
  changes one `--repair-document-meta` run (the Report Extractor Repair
  workflow, dry run by default, never while the extractor runs) reads both
  again from every row's stored text with its report date, never removing a
  name readers check or a stated period. Check each recap line of its dry run
  against its document (in the step summary), and while one is wrong
  fix the rule, never run the repair: only a `renamed` entity can make a
  withheld filing pass, and a period line's effect is the stock page's alone
  (picks and the dividend estimate read the same `period_end`).
- **A filing never overwrites a vendor value.** It fills NULL vendor fields and
  replaces only fields marked `field_sources = 'asx-filing-extraction'`. `-mode
  filings` is a fail-closed rebuild in one transaction: exit 10 = REFUSED (a read
  errored or zero extractions: nothing written), exit 1 = rolled back. A large
  purge after a gate change is expected and logged, not refused. A filing's
  net income or EPS takes its sign from its own number or the words that
  govern it, never a comparative's ("compared with a loss", "(pcp: loss ...)");
  an ambiguous sign is withheld (`5_statutory.sign_ambiguous`), never guessed.
- **Prod does not run `migrate up`**, but 000129-000132 are all in the
  terraform-deploy allowlist (replay-safe, catalog-guarded), so no hand-apply is
  needed. 000132 runs on the session pooler before the image swap, as two
  transactions under `lock_timeout = '15s'`: do not merge while
  `financial-report-extractor` or a picks refresh is running. If it cannot
  apply, `task db:prod:apply FILE=services/migrations/000132_extend_fundamentals.up.sql CONFIRM=prod`
  in a quiet window and re-run the deploy; never drop its allowlist line (the
  new jobs image writes those columns). After the deploy, `run_picks_job`
  `filings` then `refresh` clears the echo rows within the hour, one
  `--repair-echo-digests` extractor run (the Report Extractor Repair workflow,
  dry run by default) restores the echo rows' summaries (the API withholds them
  until then), and pre-000132 codes are re-fetched first,
  largest first, over the next nights.
- **000155 puts a trigger on `stock_fundamentals`, the picker's own table.**
  `trg_fundamentals_vintage` writes a `stock_fundamentals_vintages` row for every
  insert, changed update and delete (`I`, `U`, `D`) and a one-time baseline
  (`B`); an update that changes nothing writes nothing. So every write to
  `stock_fundamentals` (the vendor upsert, its pruned CTE, the filings rebuild)
  also writes a vintage, and a failed vintage insert fails that picks write. The
  vintage table is kept forever and nothing prunes it. Its JSONB repeats every
  column in every row, so a vintage table is several times the size of the rows
  it copies: a bulk rewrite of `stock_fundamentals` adds one `U` row per changed
  row, so size it before running it. The first apply takes `SHARE ROW EXCLUSIVE`
  on `stock_fundamentals`, so do not merge during 15:00-18:30 UTC or while
  `run_picks_job` runs. If the deploy's apply times out on that lock, run
  `task db:prod:apply FILE=services/migrations/000155_strategy_capture.up.sql CONFIRM=prod`
  in a quiet window, then re-run the deploy. Change `record_fundamentals_vintage`
  only through a later allowlisted migration, never by hand-apply: the deploy
  replays its `CREATE OR REPLACE` on every run, which reverts a hand fix. Read
  "the latest vintage on or before D" as `ORDER BY captured_at DESC, id DESC`:
  the vintages one transaction writes share a `captured_at`.
- **Every picks row is served three times, so the shortlist is bounded.**
  A ranked row lands in the HTML table, in the Suspense fallback's RSC tree
  and in the sort island's props, each with its fundamentals disclosure.
  With the API's 100 rows that made `/strategies/minervini-trend-template`
  1.85 MB of HTML (measured 2026-10-07). `shortlistRows` caps the server
  shortlist at `SHORTLIST_MAX_ROWS` (10, the anonymous public depth), and the
  island gets the chip `counts` from `statusCountsOf` (the API's
  `status_counts`, which stay the whole ranking under the clamp) instead of
  the rows. Under the production clamp a status or sort chip's answer is the
  public top 10 for every caller of the public RPC (`viewer.clamped`), signed
  in or not, so the island words it as the top rows and links "See all
  signals" to the Signals tab, the only place with signed-in depth. Do not
  hand the island every row again, and do not add a per-row `<details>`
  outside the fundamentals cell.
- **The base is anchored.** After a breakout `mv_price_features` reports
  `base_high` / `base_low` / `base_length_days` as at the breakout session, so the
  pivot is the level cleared (the invalidation level), and `base_length_days`
  counts from the FIRST touch of the high (a flat base reads its full length).
  Both were defects found by applying the migration to a scratch Postgres; the
  window is 40 sessions, so a base is never longer than 40.
- **Signal fields (PR-04a).** Each rule's definition (`threshold`, `unit`,
  `comparator`, `has_threshold`) comes from `engine/thresholds.go`, typed out
  again in `TestRegistryAnnotatesDefinitionFacts`; `rs_leader` has no threshold
  (its cut-off is `rs_quantile_threshold`, in points), and neither do `base`,
  `growth` or `eps_growth`, which pass on more than one condition. `rs_6m_percentile` is the
  type-7 rank, so `>= 75` is exactly the top quartile (`TestRS6mPercentileAgreesWithTheRule`).
  A rule's `unknown` says why: `no_fundamentals` for missing inputs,
  `not_meaningful` for a ratio the data withholds (revenue <= 0, the ROE equity
  guard). `status_counts` covers the whole list before any filter or paging.
  The short report dates come from the row the short figure came from
  (`strategyShortDatesQuery`, the view's own filters and figure, no age limit), so a stock
  with no figure has no date and no `short_status`. `short_available_date` is
  empty for a report dated before 2026, the holiday table's first year. The
  universe fill reads `shorts` on the views source (the default; see "Snapshot read"
  below for the snapshot source), so a failed read fails `GetStrategyPicks` and
  `GetStockStrategyFit` (`ListStrategies` reads only the regime). `stale` is set
  when the index has closed a session the prices have not reached, read from the
  regime view and from the index's own series (`latestIndexSession`).
  `ineligible_reason` is a closed vocabulary: a stock outside the universe
  reads `short_history`. Rule `value`s keep the API's precision; the
  mapper rounds only the figures a cut-off reads, rounding down.
- **Signed-in depth never enters a cache.** The Signals island reads a signed-in
  viewer's whole list through `app/actions/strategies/viewer.ts`
  (`getSignalsForViewer`, the private `GetViewerStrategyPicks`) once the session
  is known: the first page (100 rows, the API's cap) at mount. The whole list is
  read only when the viewer searches, filters, sorts or draws past that page, in
  rank order, and is sorted in the browser. The island asks for the whole list at
  most once per mount for a slug and snapshot, so turning a filter, the search or
  the sort off and on draws the list it holds; a failed read is asked again the
  next time the viewer shows more, filters, searches or sorts, and the pane says
  it is loading meanwhile. A read is also held in the tab
  for 60 seconds under the user id, session and rules version
  (`signals-read-cache.ts`, browser memory only). A full read costs one call per 100 signals, and every
  call is metered as the viewer's own browser access. That module imports no
  cache helper, and its guard test reads the source. The Signals ISR page stays
  anonymous: its HTML carries the top 10 rows and the sign-in prompt row, which
  also draws while the session loads. Rows are drawn only when the read's
  snapshot (session and rules version) matches the page's; a read whose page
  differs stops there (`snapshot-mismatch`), so a refresh can refuse it briefly
  until the page regenerates. Its transport, `app/actions/auth-transport.ts`
  (`createSignedInTransport(options)`), reads the session itself and derives the
  verified address from it: a caller passes options only. It fails closed in
  production without `INTERNAL_SERVICE_SECRET`; read-only calls send identity
  only, with no address and no Firebase lookup.

- **Daily snapshot (PR-10, migration 000156, `shorted strategies -mode daily`).** The
  job writes one session's feature rows (`strategy_features_daily`), regime and
  fundamentals blobs, then the live canonical versions' signal events, diffed
  against the previous complete session and recomputed from its stored rows. Each event's `evidence` holds one P, F or U per rule in `r` (services/jobs/README.md, "Signal event evidence"). It
  holds a session whose inputs are incomplete (ASIC sync running, the price sweep
  not completed after 05:30 UTC, priced codes under 85% of the prior median, no
  XJO bar, a weekend-dated XJO bar in its window) and backfills held sessions
  oldest first. Dry run unless `STRATEGIES_DRY_RUN=false`. Container suite:
  `make test-strategies-daily-pg`. Admin `strategy_status` (`jobs:read`) reports
  the phases, holds and table sizes, and the backtest queue and runs (see the
  backtest job below), aggregates only.
  **Index dates are fixed in the tree (#860).** The job reads stored XJO dates for the data calendar, the regime
  and RS. Rows inside the scheduled index window (`-years 2`) are dated by ASX session once the index sync has run;
  the one-off full-history re-fetch ran on 2026-11-05, so older history is re-dated too, before the job's
  first session (a completed features phase is read back, never recomputed).
  Readiness rule (e) holds with `xjo_weekend_rows` while any XJO bar in the window
  is dated on a weekend, so a deploy ahead of the fix holds and pages rather than
  writes. Merge PR-10, and enable writes, only after
  `task db:prod:psql -- -At -c "SELECT count(*) FROM index_prices WHERE index_code = 'XJO' AND EXTRACT(ISODOW FROM date) > 5"`
  returns 0 (481 on 2026-11-05); that whole-table count also needs the one-off
  `-years 21` XJO re-fetch. Runbook (recompute, a dead session, the spot check):
  `services/jobs/README.md`, "Strategy daily snapshot".
- **Snapshot read (PR-11, `STRATEGY_SOURCE`).** `views` (the default, and what
  production runs until PR-11b) keeps the SQL views. `snapshot` evaluates the
  newest completed session of the daily snapshot (`ReadStrategySnapshot`: the
  newest two sessions whose features, evaluation and events phases all completed,
  then that session's `fs1` rows, blobs and regime). The Terraform variable is
  `strategy_source` on `terraform/modules/shorts-api` (set to `"views"` in
  `terraform/environments/prod/main.tf`); PR-11b is the one-line change to
  `"snapshot"`. A database without 000156 (42P01) or with no whole session serves
  the views and logs at warn or error. Any other snapshot error fails the read.
  Snapshot reads: the picks, the fit, the status counts, `session_date`,
  `short_report_date`, `stale`, the short availability date (the stored sf0 date,
  empty for a report before 2026 as on the views) and `ListStrategies`' regime
  (the universe's under `snapshot`; the views' only when the universe read fails).
  Not from the snapshot: the data status' availability calendar (the ASX calendar). `GetStrategyDataStatus` (public, cached 5 min per instance) reports
  the sweep, the snapshot session, the priced count, the newest 10 ASIC reports
  and `next_update_utc` (13:00 UTC on the next trading day under `snapshot`,
  13:30 under `views`). `ListStrategySignalEvents` (private) serves the canonical
  live or superseded versions from `live_from` only, keyset on `id`; a variant or
  unregistered hash is NotFound, and a registered version that is neither live nor
  superseded reads no events. Container suite: `make test-strategy-snapshot-pg`, which
  gates the deploy. Live check: `scripts/strategies/snapshot-cutover-check.mjs`
  (`record` pages every list to `total_count` and fails on a clamped read; pass
  `--token-env` once the public depth clamp is on; `diff` requires both recordings
  to be one session and the after recording to be the snapshot's).

- **Backtest job (PR-16a, migration 000158, `shorted strategies -mode backtest`).**
  A VKE CronJob (`shorted-strategies-backtest`, hourly at :20, 1536Mi request and
  3Gi limit, `vkeNative`, `clusterOnlyJobs`). It idles, exit 0 in milliseconds
  without touching the database, until a live canonical version other than v0 has
  a recipe. Each execution takes the `strategies-backtest` lease, fails any request
  a SIGKILLed execution (an out-of-memory kill) left `running` ("the execution that
  claimed it did not finish"; requeueing it would rerun an out-of-memory request
  every hour), queues the ISO-week publish request of each key, and runs at most
  five requests (publish before variant) over one REPEATABLE READ, READ ONLY
  snapshot, holding the batch while an XJO or XJT row is dated on a weekend. A
  SIGTERM (a drain, or the 3300 s deadline) instead cancels the run and requeues its
  open requests, the one that was running included. A version or recipe the daily
  snapshot has not recorded yet is requeued by each run, and each run loads the
  whole history before it finds that out: until the daily snapshot records v1, the
  hourly runs read the history and leave their requests queued, they do not idle.
  A key with no succeeded run gets its day's immediate request once its weekly
  request has failed (then one a UTC day while it keeps failing); a key with a
  succeeded run waits for the next ISO week's request. A publish's first attempt
  for a given input and output runs the verify pass from a second read (a
  mismatch is exit 10, a determinism failure). A fundamentals strategy whose
  window is `computable_from` gets pass 1 only: the derived date and label are
  stored, never a simulation. Failed requests exit 1. Dry run unless
  `STRATEGIES_DRY_RUN=false`. Container suite: `make test-strategies-backtest-pg`.
  **The publication gate (PR-16b)**: every computed publish is stored; it is
  flipped to published only when the verify pass reproduced it, coverage is
  computed under both measures, the five sensitivity runs are complete (or each
  says why it does not apply) and the same-data reference is computed. Every publish stores a diff note in
  `summary.diff` (state `none`, `unchanged` or `changed`; the codes whose price
  history up to the previous run's cut-off changed; the ASIC codes revised in
  reports that run read, recorded after its snapshot; the CAGR shift over the
  shared window), computed against the previously published run of the key on the
  same engine. A flip stamps `diagnostics.published_at` and the run's snapshot time
  is `diagnostics.read_at`. Retention keeps the two newest published runs of each
  key (across engines), so a diff can always read the run it replaced. Engine
  `1.1.0` (a minor bump: new capability, no output change) reruns every live key.
  Admin `strategy_status` (`jobs:read`) reports the queue and the ten newest
  canonical runs, aggregates only. Admin `queue_strategy_backtest` (`jobs:run`)
  queues a publish of a live canonical version (the code registry's, with its
  recipe): a variant or an unregistered version is refused, and a request the job
  would not run is never queued.

### Saved strategies and My strategies (`/strategies/my`)

- **Table `user_saved_strategies` (migration 000157, allowlisted after the strategy capture migration, before the 000138 closer).**
  The key is `(user_id, strategy_ref)`; `strategy_ref` is a canonical id or `variant:<id>`. Nothing is granted.
- **RPCs** `SaveStrategy`, `UnsaveStrategy` and `ListSavedStrategies` are `VISIBILITY_PRIVATE` on
  `StrategyService`, mirrored on the legacy service. The owner is the verified uid only. The cap is 20
  (`shortsstore.MaxSavedStrategies`): the save takes a per-user advisory lock, so the cap is exact under
  concurrent saves, and a repeat save succeeds at the cap. A save past the cap is `PermissionDenied` with
  `X-Entitlement-Detail` naming `cap_reached` (the web reads that detail, not the code). A save waits at most
  one second for the lock and otherwise answers `Unavailable`, so a retry is safe and the pool is never parked.
- **Variant refs** resolve under the caller through `strategy_variants` (the variants migration when it lands;
  it must exclude soft-deleted rows). A database without that table owns no variant, so a variant save is `NotFound`.
- **Web**: the static shell `app/strategies/my/page.tsx` and `my-strategies-island.tsx`. The server actions
  are `app/actions/strategies/saved.ts` (identity only, no cache). The Save control is
  `app/strategies/save-strategy-button.tsx` on the Signals header. It is gated by the `saves` capability and
  by a signed-in session. Only `saves` is on among the capabilities.
- **Tests**: `services/migrations/strategy_saves.test.mjs`; `shorts/internal/services/shorts/strategy_saves_test.go`
  (unit); `make test-strategy-saves-pg` (container: the cap under 25 concurrent saves, the variant guard, replay).

## Strategy chart primitives and returns kit (PR-17)

Primitives only: no page uses them yet (PR-19 Backtest and PR-20 Explore do).
They are in place so the chart and table code is reviewed once.

- **`StockChart` extensions are default-off.** A chart with none of them renders
  byte-identically. `StockChartInner` props and series fields: `series.dash`,
  `series.endLabel` (read from the drawn points, so a zoom and the normalised
  view are right), `regions` tone `"live"` (a token tint, its label written on
  the band when it fits; `bearish`/`bullish` stay fixed hexes), `levels[].tag`
  (a boxed label, spaced 15px), `events` (dots in the entry, exit and neutral
  tokens), `annotations` (a plot callout), and `oscillators[].kind = "area"`
  with `oscillators[].annotations` (a drawdown panel, with true-minus ticks and
  its trough callout on the panel's own domain). Line oscillators keep their
  output (Williams %R has negative levels).
- **Returns kit**: `components/strategies/` holds `ReturnsHeatmapTable`
  (server `<table>`, `span` merges columns, a bin is taken from the figure as
  printed), `CoverageStrip` (`rows` or a `columns` month strip), and
  `EquitySparkline`. The bins, fills and contrast live in
  `lib/strategies/returns-scale.ts`. `.hatch-empty` (state), `.hatch-bar`
  (a coverage bar under 80%) and `.hatch-on-fill` (the hatch inside a filled
  cell) are the three hatch utilities in `styles/globals.css`.
- **Guards**: `components/strategies/__tests__/colour-rules.test.ts` (no market
  mark token, raw hex or Tailwind red/green utility in the kit) and
  `client-boundary.test.ts` (the import walk reaches no `~/gen`, protobuf,
  `@connectrpc` or server action, and no kit file is a client component).
  `returns-scale.test.ts` checks the ink on every fill and on every filled
  cell's stripes, in both themes, against the real tokens in `globals.css`.
- **Recorded deviations from the spec (1.5 and 10.6-10.8)**: the StockChart
  colours stay the existing hexes, so existing output is unchanged (the spec
  asked for semantic tokens); the returns cells mix over `--returns-paper`
  (a new token, light sand in dark) rather than `var(--background)`, which
  keeps the ink above 4.5:1 in both themes; a `CoverageStrip` month row is the
  `columns` layout here rather than a separate primitive.

