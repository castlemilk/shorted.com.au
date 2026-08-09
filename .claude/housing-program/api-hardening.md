# Work package: api-hardening

Housing API read-path hardening: AVM gating, takedown completeness, input normalization, cache-key hygiene

## Ground rules (read first)

- You are in a git WORKTREE of the Shorted repo on your own branch. Commit ALL your work
  with conventional-commit messages (one commit per logical unit is fine). Do NOT push,
  do NOT merge, do NOT switch branches, do NOT touch main.
- Before coding, read the Housing section of the repo CLAUDE.md and skim
  docs/housing-architecture.md for the landmines that apply to your files. Non-negotiable
  repo rules: interactive charts import via dynamic(ssr:false) from "use client" modules;
  never pass functions across the RSC boundary; read searchParams client-side (useSearchParams
  under Suspense) on ISR pages - a server-page searchParams read silently forces dynamic;
  server actions use getShortsApiUrl() from app/actions/config.ts, never env vars directly;
  KV reads go through the readCached non-emptiness predicate.
- Migrations: the prod deploy does NOT run migrate up (hand-apply regime). Do NOT create
  migrations unless your spec explicitly assigns you migration numbers. If a schema change
  seems needed but is not assigned, write it up in your final summary instead.
- Do not modify .proto files or run buf generate. If a proto change seems needed, note it
  in the summary.
- Keep the diff scoped to the findings below. No drive-by refactors, no formatting sweeps.
- QA before you finish: run the narrowest relevant tests (go test ./... scoped to the
  packages you touched; for web: cd web && npx tsc --noEmit plus any touched jest suites)
  and report the actual results honestly in your final summary. If something fails and you
  cannot fix it within scope, say so plainly.
- Finish with a summary: what you changed per finding, what you deliberately did not do,
  test results, and anything the reviewer must hand-verify.

These findings come from a 24-agent adversarial audit (2026-08-09); each was independently
verified against the code. Evidence line references were correct as of audit time - re-locate
if lines shifted.

## Track notes

F08: gate the per-address AVM/sales-history read path behind the same licence
posture as the rest of the crawl tier (kill switch + aggregate-only defaults) per migration
000088's own warning - the raw per-address serving contradicts the stated posture. F34: make
flipping HOUSING_DROP_LISTINGS_ENABLED actually effective within minutes: on-flag-flip (or
on every gated read) bypass/invalidate the KV entries and document the ISR flush call
(/api/revalidate?path=/price-drops&flush=housing) as part of the takedown runbook comment.
F18/F19: normalize state codes case-insensitively on ALL housing RPCs, return
InvalidArgument (not empty-200) for malformed states, and build every cache key from
normalized params via one shared helper so semantically identical requests share an entry.
Do not touch proto files.

## Findings (verbatim from the audit)

### F08 [high/risk] Per-address AVM estimates + full sales history are served verbatim, directly contradicting migration 000088's own written licence posture

**Detail:** Migration 000088's header states the harvested property.com.au profile 'MUST NEVER be republished raw. Only DERIVED aggregates are a publishable surface; the raw profile is stored for internal enrichment only.' But the live read path publishes per-address raw extracted facts: GetPropertyHistory embeds a PropertyValuation with estimate_low/mid/high, estimate_confidence, rent_estimate_mid, year_built, land/building size, and the FULL per-sale sales_history (date, price, agency, type) verbatim. property.com.au's ToS posture is ESCALATED vs REA/Domain listings — its robots.txt explicitly bans aggregators (acknowledged in the same migration header). The HOUSING_VALUATIONS_ENABLED kill switch exists but defaults ON. The store does exclude raw/content_hash/lat/lng, and the owner consciously accepted the risk per memory — but the written posture and the code directly contradict each other, and if a takedown/legal letter arrives the migration text is discoverable evidence the team knew the surface wasn't publishable.

**Evidence:** migrations/000088_add_property_valuations.up.sql:9-13 ('MUST NEVER be republished raw... internal enrichment only') vs services/shorts/internal/services/shorts/house_prices.go:543-575 (verbatim EstimateLow/Mid/High + SalesHistory proto) and :419-426 (valuationsEnabled default true); postgres_house_prices.go:899-901 (raw/lat/lng excluded).

**Suggested fix (advisory, you may do better):** Make posture and code agree: either amend 000088/docs to record the accepted per-address publish posture and its kill switch, or reduce the surface to banded estimates ($50k bands) and sale-year-only history. Document HOUSING_VALUATIONS_ENABLED in the takedown runbook.

**Verifier note:** All four evidence citations verified verbatim: 000088 header (lines 9-13) forbids raw republication and limits publishing to derived aggregates; house_prices.go:543-575 serves per-address EstimateLow/Mid/High, confidence, rent estimate, year built, land/building size and the FULL sales_history verbatim; valuationsEnabled() (419-426) defaults ON; the store excludes only raw/content_hash/lat/lng. Not fixed later: the migration header was never amended (git log: only the original PR #335 scaffold commits), the read path merged to origin/main via PR #341 (842505bab), the frontend renders it (property-valuation-card.tsx), and prod Supabase currently holds 34 rows / 20 servable ok-status valuations (all 20 with sales histories, 9 with AVM estimates, fetched 2026-07-23/24) — so the surface is live today. Refutation attempt found one nuance: docs/property-avm-read-path-plan.md (shipped with #341) DOES record the accepted per-address posture + kill switch (half the suggested fix exists), but it inverts the migration's rule (calls per-suburb aggregates 'licence amplification' and per-address display 'the defensible surface'), so the repo now contains two directly contradictory written postures plus a live surface matching neither the migration text — the finding's core claim and discoverable-evidence concern stand. Severity stays high (not critical): exposure is real and live but tiny (~20 addresses), deliberately mitigated (kill switch, deep-link-out, no raw/lat-lng/bulk), and the actionable defect is posture reconciliation rather than an accidental leak.

### F34 [low/risk] Takedown-response gaps: flipping the drops kill switch leaves agency/agent/address data serving from web KV + ISR up to 24h, and REVALIDATION_SECRET travels as a URL query param with non-constant-time comparison

**Detail:** (a) HOUSING_DROP_LISTINGS_ENABLED is correctly checked before the backend cache, but the web layer independently caches flag-on responses — including agency names, agent personal names and per-address drops — in Upstash under PRICE_DROPS_TTL = 86400s, and /price-drops is static ISR (1h). A takedown response therefore needs three separate actions (env flip + ?flush=housing KV purge + ISR revalidate) that no runbook bundles; miss one and the content the switch exists to pull keeps serving up to 24h. (b) pingRevalidate puts the shared secret in the query string and /api/revalidate reads it from searchParams — recorded in Vercel edge/function logs and any intermediate proxy logs — and the comparison is non-constant-time. Storage is otherwise clean (Secret Manager mount, local rig env file).

**Evidence:** kv-cache.ts:124 (PRICE_DROPS_TTL 86400); getHousing.ts:167-277 (caches the four drops actions); house_prices.go:436,478,592,677 (backend-only flag check); revalidate.go:37-38 (q.Set("secret", ...)); route.ts:39-43 (searchParams read, secret !== expectedSecret).

**Suggested fix (advisory, you may do better):** Add a one-shot takedown path (make target or admin flush endpoint) that flushes cache:housing:drops:* and revalidates /price-drops + /housing/[state], documented as one runbook step with the env flip; move the secret to an Authorization/X-Revalidate-Secret header (query fallback one release), compare with crypto.timingSafeEqual, rotate after cutover.

### F18 [medium/bug] Public API contract inconsistencies: case-sensitive state codes on 2 of 4 RPCs, empty-200 instead of InvalidArgument (negative-cached 5 min), silent degradation with zero logging, stale proto docs, and uncapped >40% typo events in raw history

**Detail:** (a) ListSuburbPriceDrops and ListStateSuburbs filter state_code case-sensitively while ListAddressPriceDrops/ListAgencyPriceStats normalize — `state_code:"nsw"` silently returns an empty 200 (then negative-cached) on two of four public RPCs while identical requests work on the others. (b) GetPropertyHistory returns an empty 200 for a missing address_key (sibling RPCs return CodeInvalidArgument), so consumers can't distinguish bad request / unknown address / kill-switch-off; the empty result is produced inside GetOrSet so unknowns are cached 5 min — the server layer has no equivalent of the web KV never-cache-empty guard. (c) GetSuburbProfile swallows similarSuburbs/suburbCrime errors with no logging, so a persistent failure (e.g. MV missing pre-hand-apply) silently strips profile sections. (d) housing.proto documents sort as count|avg|max but the store+UI also support 'asking' and 'sold', and window_days is declared reserved and silently ignored — the stale doc is duplicated on the legacy service the public OpenAPI is generated from. (e) GetPropertyHistory's raw timeline returns 65 uncapped price_drop events >40% (max 91.8% — listing-typo corrections) that every board/aggregate path caps, so a viewed address can render '-91.8%' as a real cut, unannotated.

**Evidence:** postgres_house_prices.go:709/:327 (= $1) vs :1146/:1328 (UPPER); house_prices.go:682 (only ListAgencyPriceStats normalizes), :475-477 vs :433-435, :482-491 + cache.go:107-113 (empty cached); postgres_house_prices.go:462-467 (two `if err == nil` blocks, no log) vs house_prices.go:518-523; housing.proto:341-343 vs postgres_house_prices.go:676-687 + suburb-price-drops-panel.tsx:11; prod: 65 events drop_pct>0.4, max 0.9179, uncapped query at postgres_house_prices.go:959-965.

**Suggested fix (advisory, you may do better):** Uppercase/trim state_code in all four handlers before cache key + store call; return CodeInvalidArgument for empty address_key and skip Set for empty responses; log degradations at Warn; fix the proto field comments on both copies; tag >40% events as 'likely correction' in the timeline response.

### F19 [medium/risk] Cache keys built from raw un-normalized params on 5 of 6 drops/suburb RPCs — duplicate-entry fanout and unbounded distinct-key cache fill by anonymous callers

**Detail:** Only ListAgencyPriceStats normalizes inputs before building its cache key. ListSuburbPriceDrops, ListSuburbDropListings, ListAddressPriceDrops, ListStateSuburbs and ListHousingRegions key on raw request values while the store clamps them afterwards (limit<=0||>200 → 50; windowDays<=0||>365 → 90), so windowDays=0 and 90, limit=0 and 50 hold duplicate entries for identical responses — and free-text params (ListStateSuburbs.query, ListHousingRegions.query, GetHousingOverview.region_type) let an anonymous caller (30 req/min/IP) mint one new in-memory cache entry per request, each ListStateSuburbs entry up to a ~5,000-row response, with cleanup only evicting expired entries every 5 min. All inputs are IN the keys, so this is fanout/memory growth, not cross-poisoning.

**Evidence:** house_prices.go:368,439,595,110,330 (raw m.* into key builders) vs :680-693 (normalized, with explanatory comment); store clamps at postgres_house_prices.go:1103-1108 etc.; NewMemoryCache(5*time.Minute) at server.go:35; cache.go:147-165 (eviction).

**Suggested fix (advisory, you may do better):** Hoist the store's clamp/normalize rules into the handlers (shared helper) before cache-key construction, matching the ListAgencyPriceStats and register-layer patterns.

