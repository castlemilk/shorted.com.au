# Wave-2 work package: price-drops-choropleth

Choropleth board on /price-drops: shade states by drop share, click through to ?state=

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

Everything needed is committed already: ChoroplethMap supports continuous fills + legends,
states.topojson is in /public/geo, and GetPriceDropsOverview already returns per-state drop share and
median cut (StateDropsBoard renders it as a table today). Add a small ssr:false map shading states by
dropSharePct, clicking a state sets the existing ?state= deep link. CRITICAL: /price-drops is static
ISR (1h) + KV (24h) and the ?state= param is deliberately read CLIENT-side under Suspense - do not
move that read into the server page or you silently kill the ISR (this exact regression is documented
in the repo). Reuse the existing legend/colour-ramp conventions from the housing maps so the board
gains the same visual identity. Keep the table - the map is an addition, not a replacement (the table
is the accessible/crawlable representation).

## Enhancements (verbatim from the audit)

### Choropleth board on /price-drops (drop-share by state)

**Value:** high · **Est. effort:** M

Everything needed is already committed: ChoroplethMap supports continuous fills + legends, states.topojson (493KB, CF-edge-cached) is in /public/geo, and GetPriceDropsOverview already returns per-state drop share / median cut (StateDropsBoard consumes it as a table). A small ssr:false map shading states by dropSharePct with click-through to ?state= would give the flagship board the same visual identity as /housing and make the state comparison legible at a glance.

