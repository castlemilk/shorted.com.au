# Work package: crawl-correctness

Crawl classification correctness: thin-suburb false blocks, trace panic safety, medians contract

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

F12: use the on-target total (PageMeta/listings_total) so a genuinely small
result set on page 1 is classified as exhausted rather than blocked; keep the early-page
Kasada block detection for pages that SHOULD have stock. Add table-driven tests over the
classification matrix (small suburb, poisoned early page, healthy sweep, late broadening).
F36: bring the trace screenshot path up to the #405 protections (nil-context guard, bounded
goroutines). F35: bring the medians-tier brandbrain reporting back to the counts-only
contract (strip whatever listing-level fields leak). NOTE: PR #408 (open) already addresses
the circuit-open-banked-as-succeeded issue (F10) - do NOT duplicate it; rebase-friendliness
is enough.

## Findings (verbatim from the audit)

### F12 [high/bug] Thin-suburb false-block root cause unfixed: a genuinely small suburb's page 1 still reads as a Kasada block, burns attempts, trips circuits, and can stop the whole drain

**Detail:** A suburb with fewer than CRAWL_LISTINGS_MIN_PER_PAGE (default 5) on-target listings on page 1 is classified sweepBlocked (stop-thin-page1) and increments the block counter — indistinguishable from a real Kasada stub. Consequences: (a) the job fails and burns queue attempts; (b) two consecutive thin jobs on one source open that source's circuit (circuitTrip default 2), after which healthy suburbs get skipped (and, per F10, banked 'succeeded'); (c) two DISTINCT thin suburbs back-to-back still trip blockTracker (default 2) and stop the drain with exit 3 — #401 only fixed the same-suburb re-serve case; (d) delta enqueue ranks never-crawled suburbs FIRST, so permanently-failing thin suburbs cluster at the head of every daily run. The live rig env and all deploy wrappers set no override, so scheduled runs can re-wedge exactly as observed with Lane Cove North. REA's already-extracted PageMeta.OnTargetResults provides ground truth (a portal-reported on-target count < 5 proves real inventory, not a block) but the gate ignores it.

**Evidence:** crawl_listings.go:105 (default 5), :616-620 (stop-thin-page1 → sweepBlocked + blockCounter++); crawl_agent.go:583 (trip default 2), :670-678 (distinct-suburb degraded stop); crawl_delta.go:93-96 (never-first ranking); grep MIN_PER_PAGE in deploy/*.sh = comment-only; ~/.shorted-housing-crawl.env has no override (verified).

**Suggested fix (advisory, you may do better):** When metaOK && meta.OnTargetResults < minPerPage, classify a thin page 1 as sweepComplete (delist-safe genuine exhaustion) instead of sweepBlocked; keep the blocked classification only when meta is absent or claims more inventory than rendered.

**Verifier note:** Every evidence point verified at HEAD. crawl_listings.go:105 defaults CRAWL_LISTINGS_MIN_PER_PAGE=5; lines 616-620 classify a thin page 1 as sweepBlocked (stop-thin-page1) + blockCounter++ with NO consult of the metaOK/meta.OnTargetResults values extracted just above (553-566) — the suggested fix's premise is accurate (REA-only; Domain lacks OnTargetResults). Full consequence chain confirmed: (a) blocked sweeps are discarded wholesale so Events==0 && BlockedSweeps>0 → agentJobTerminal "failed" → burns queue attempts; (b) cb.record(source, reaBlocks>0) at crawl_agent.go:780/794 with circuitTrip default 2 (crawl_listings.go:118) → 2 consecutive thin jobs open the source circuit, and circuit-skipped jobs are banked "succeeded" (crawl_agent.go:808-811) — the fix for that banking (6a99b853f) lives only on unmerged branch fix/crawl-defer-circuit-open; (c) blockTracker (crawl_agent.go:583 trip=2; record 926-938) escalates on DISTINCT suburbs → degraded break → return 3 (line 735); #401 (f85f685e7) only exempted same-suburb re-serve; (d) crawl_delta.go:93-97 ranks never-crawled first and queryCatalogFreshness derives LastCrawled from property_listings.max(last_seen_at), so a permanently-blocked suburb stays "never-crawled" and heads every delta run. No deploy wrapper or ~/.shorted-housing-crawl.env override exists (grep = comment-only in run-housing-rescan.sh:25). git log -S stop-thin-page1 shows the gate unchanged since introduction (691878444); no later fix on main. Live incident corroborated by memory/housing-crawl-outage-modes.md §2 (Lane Cove North NSW 2066: drain died after 2 jobs, 300 healthy jobs untouched; scheduled runs can re-wedge). Severity high: real, live-observed reliability gap that silently stops the production crawl drain, but no data corruption/security/licence exposure (a false block delists nothing by design), so not critical.

### F36 [low/bug] Trace screenshot path lacks the #405 protections: nil-context panic can take the collector down and an unbounded Goto under the mutex can deadlock subsequent fetches

**Detail:** PR #405 hardened cdpFetcher.fetch with a nil-ctx guard, a wall-clock watchdog, and panic recovery. cdpFetcher.screenshot (CRAWL_TRACE full mode only) got none: it calls f.ctx.NewPage() with no nil check — after a failed reconnect nils f.ctx, a traced sweep panics on the main goroutine — and its page.Goto runs unbounded under f.mu, the exact pipe-hang class the fetch watchdog exists for (a hung screenshot also deadlocks subsequent fetches waiting on the mutex). Only reachable with tracing enabled, so blast radius is a debug run — but that is precisely when an operator is already fighting a flaky Chrome.

**Evidence:** crawl_cdp.go:282-310 (screenshot: f.ctx.NewPage() at :289, no nil guard, no watchdog) vs :107-111 (fetch nil guard) and :151-187 (fetchGuarded watchdog + recover).

**Suggested fix (advisory, you may do better):** Route screenshot through the same guarded pattern (nil-ctx check + watchdog goroutine with recover), or drop the screenshot on any error without touching shared state.

### F35 [low/risk] The 'counts-only, no listing data crosses to brandbrain' contract holds for the listings/agent tier but not the medians tier, which POSTs full portal HTML to brandbrain's ExtractRealEstate

**Detail:** crawl_agent.go:24-25 and CLAUDE.md state 'no listing rows / addresses / PII ever cross to brandbrain', and the agent-queue path honours that (crawlJobSummary is tallies only). But the median tier (-mode crawl) deliberately POSTs entire rendered suburb SRP HTML — addresses, prices, agents — to api.brandbrain.dev's ExtractRealEstate LLM RPC. brandbrain is first-party infrastructure, but proprietary-ToS portal content leaving the rig contradicts the stated contract and the trace-hygiene posture ('trace artifacts hold portal data → local-only, never uploaded'). The contract statement is scoped wrong rather than the behaviour being new — but an auditor or maintainer reading either doc will draw the wrong conclusion.

**Evidence:** crawl_agent.go:24-25 (contract claim) vs crawl_brandbrain.go:15-30 + crawl.go:307 (extractRealEstate POSTs rendered HTML); deploy/README.md:380-381 (trace 'never uploaded to brandbrain').

**Suggested fix (advisory, you may do better):** Amend the contract comments/docs to scope counts-only to the listings/agent tier and explicitly document the medians tier's HTML→ExtractRealEstate flow (retention + purpose), or retire the medians brandbrain path if the tier is dormant.

