# Wave-2 work package: housing-embeds

Housing embeds + open-data hub entries for the backlink / Dataset-Search program

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

The shorts side already has a proven embed-backlink program (/embed/chart, /embed/treemap,
/embed/top-shorts, /embed/bank-basket) and a /data open-data hub with Dataset JSON-LD - but the
DATASETS array is shorts-only and there is no housing embed. Build /embed/housing-series (region x
measure chart) and /embed/price-drops (state board), copying the existing embed route conventions
exactly (same attribution-link pattern, same lightweight layout, same caching/ISR posture, same
'powered by shorted.com.au' backlink). Then add 2-3 housing Dataset JSON-LD entries to the /data hub:
national price series, suburb medians, price-drop aggregates.
LICENCE GATE - the deciding constraint: ABS/RBA series are CC-BY-4.0 and republishable WITH
attribution; crawl-derived data is proprietary-tos-restricted and must never be republished raw. The
price-drops embed may only expose OWN-DERIVED AGGREGATES (state-level drop share / median cut), never
listing-level rows, addresses or agency detail. Read docs/feature/housing/data-sources.md before you
choose what an embed may show, and state your licence reasoning in the summary.

## Enhancements (verbatim from the audit)

### Housing embeds + open-data hub listing for the backlink/Dataset-Search program

**Value:** high · **Est. effort:** M

Exists: a proven embed-backlink program for shorts (/embed/chart, /embed/treemap, /embed/top-shorts, /embed/bank-basket; PR #374 live) and a /data open-data hub with Dataset JSON-LD — but the DATASETS array is shorts-only (grep housing → 0) and no housing embed exists. The ABS/RBA house_prices series are CC-BY (republishable) and the price-drop rollups are own-derived aggregates. Increment: /embed/housing-series (region×measure chart) + /embed/price-drops (state board) with the same attribution-link pattern, plus 2-3 housing Dataset entries (national prices, suburb medians, price-drop aggregates) with CSV endpoints on /data. Value: backlinks from property/finance bloggers + Google Dataset Search visibility for 'australian house prices dataset'.

