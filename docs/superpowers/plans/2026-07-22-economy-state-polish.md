# Economy State Polish Implementation Plan

> Executor: **Codex CLI** (`codex exec`, model gpt-5.6-sol @ xhigh — user-config default), one task per invocation, driven and reviewed by the coordinator (fable). Worktree: `~/projects/.worktrees/shorted-economy-map`, branch `feat/economy-state-polish` (off origin/main). NEVER touch `~/projects/shorted`.

**Spec:** `docs/superpowers/specs/2026-07-22-economy-state-polish-design.md`

Shared context every task gets: repo conventions live in `CLAUDE.md` (Economy
section) + `docs/economy-architecture.md`; verify with the raw go binary /
`SKIP_ENV_VALIDATION=1` for web builds; commit with `--no-verify` (known
pre-existing hook failure); local DB `postgresql://admin:password@localhost:5438/shorts`.

## Task 1 — Banner generation tooling + assets
Clone `web/scripts/housing-banners/` → `web/scripts/economy-banners/` (reuse
palette/tone by import where clean). 8 state archetype prompts per spec §A.
Generate via the direct OpenAI path (`OPENAI_API_KEY` read-only from
`~/projects/shorted/services/.env`; 8 × gpt-image-1 landscape ≈ <$1), bake
light+dark toned variants → `web/public/economy-banners/` + a tiny generated
manifest. Verify: files exist, both themes visually distinct (coordinator eyeballs).

## Task 2 — StateBanner component + page integration
`web/src/@/components/economy/state-banner.tsx` modeled on
`housing/suburb-banner.tsx`: toned bg (theme-switched), **centered state
silhouette** from `/geo/states.topojson` (d3-geo path, fitExtent with generous
padding — this replaces the locator inset and satisfies "nicely center the
state"), serif name, scrim, breadcrumbs overlay. Wire into
`/economy/[state]/page.tsx` (remove the locator-inset usage + its loader if
orphaned). Jest for the silhouette path math if pure-extractable; tsc; build
(routes stay SSG); Playwright both themes + mobile.

## Task 3 — Three SDMX importers (approvals / retail / population)
Per spec §B, full established discipline (probe→pin→name-based→fail-closed→
fixtures→registry→`-mode all`). Study `cpi.go`/`labour.go` first. Live smokes
with magnitude cross-checks (NSW ERP ~8.2M, national retail ~$37B/mo,
approvals plausible thousands/mo). `-mode all` exit 0.

## Task 4 — GovFin detail + links + web surfacing
§C + §D: additive govfin line items (+fixtures), `state-finance-links.ts`
registry + "Sources & further reading" block, new state-page charts (retail /
approvals / population growth), correlation candidates additions, two new map
metrics (`retail`, `population_growth` diverging). tsc/jest/build/Playwright.

## Task 5 — Integration + ship (coordinator)
Full suites, fable whole-diff review, migration-number check vs origin/main
(the 000083 lesson), PR, merge, deploy-watch, collector execute, revalidate
sweep, live verify.
