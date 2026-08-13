# Web Suburbs Completion Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining `web-suburbs` requirements on top of commit `76fd3fc1d` without redoing correct WIP work.

**Architecture:** Keep `suburbSlug` as the URL source of truth, resolve legacy trailing-hyphen URLs through the same state index, and let the dynamic segment use daily on-demand ISR without reading server `searchParams`. Distinguish genuine misses from service failures, retain the permanent legacy-route redirect while deleting its unreachable implementation, and explicitly trace OG logo assets into every shared-card lambda.

**Tech Stack:** Next.js 14 App Router, TypeScript, React server components, Connect RPC, Jest/ts-jest, Playwright.

---

### Task 1: Reconcile the WIP with branch ownership

**Files:**
- Modify: `CLAUDE.md`
- Modify: `web/src/@/components/housing/__tests__/suburb-cleanup.test.ts`

- [x] Restore the WIP-only `CLAUDE.md` line to the package base so the parallel docs branch owns the housing documentation.
- [x] Remove the cleanup test's assertions about `CLAUDE.md`, retaining only executable-code cleanup assertions.
- [x] Verify `git diff 8c120a352..HEAD -- CLAUDE.md` is empty after the new commit.

### Task 2: Strengthen F03/F04 regression coverage

**Files:**
- Modify: `web/src/app/__tests__/housing-sitemap-slugs.test.ts`
- Modify: `web/src/app/actions/__tests__/getHousing.test.ts`
- Modify: `web/src/app/housing/[state]/[suburb]/__tests__/page-runtime.test.tsx`
- Modify if a failing test proves it necessary: `web/src/app/actions/getHousing.ts`
- Modify if a failing test proves it necessary: `web/src/app/housing/[state]/[suburb]/page.tsx`

- [x] Add behavior-level tests proving empty-postcode sitemap records produce no trailing hyphen and legacy one-hyphen slugs resolve.
- [x] Add tests proving a genuine slug miss returns `null`, state-index unavailability throws, and profile NotFound is distinguishable from transient unavailability.
- [x] Add route tests/source contracts proving no server `searchParams` read, daily on-demand ISR exports, canonical redirects, and outage paths do not call `notFound()`.
- [x] Run each new test before implementation changes and record the expected failure when a production correction is needed.
- [x] Make only the minimal production correction required by a failing test, then rerun the narrow suite to green.

### Task 3: Verify F25/F26/F37 and the complete package

**Files:**
- Verify: `web/next.config.mjs`
- Verify: deleted `/housing/suburbs` route/component files
- Verify: `web/src/@/components/housing/suburb-profile.tsx`
- Verify: housing/editorial/economy link files
- Verify: `web/e2e/web-suburbs.spec.ts`

- [x] Run all touched Jest suites and report exact suite/test counts.
- [x] Run `npx tsc --noEmit`.
- [x] Run ESLint on every changed TypeScript/TSX/JavaScript file that still exists.
- [x] Run the targeted Playwright suite when the sandbox permits a local port; otherwise report the bind failure plainly.
- [x] Attempt a production build with static generation skipped to inspect OG `.nft.json` tracing and route rendering classification; report environmental blockers such as font/network access.
- [ ] Inspect the final diff and commit all completion changes with a conventional commit, without pushing, merging, switching branches, or rewriting history.
