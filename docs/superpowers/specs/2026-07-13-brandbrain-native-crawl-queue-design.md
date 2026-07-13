# Brandbrain-native real-estate crawl queue (Approach B)

**Status:** Draft design — awaiting user sign-off before any brandbrain-repo change
**Date:** 2026-07-13
**Chosen by user** over Approach A (one-way run-report). Supersedes `2026-07-13-brandbrain-crawl-run-tracking-design.md` for the tracking goal.
**Related:** `2026-07-13-realestate-subcrawler-distributed-design.md` (§ Phase Queue), memory `realestate-subcrawler-distribution`.

## Goal
The housing crawl runs **through** the brandbrain agent, not beside it: brandbrain owns a durable job queue; residential collectors **poll** brandbrain for a suburb to crawl, do the crawl, and report completion. This realizes the user's original vision — "jobs hit brandbrain → queued → crawled by agents" — and gives full visibility + dynamic distribution.

## Principles carried over (locked in v2 of the main spec — do not relitigate)
1. **Job = one suburb sweep** (not one URL) — preserves the tested delist-safety (`complete`/`partial`/`blocked`).
2. **Extraction stays agent-local** — the collector extracts listings + medians locally (µs, 171 tests); brandbrain never parses listing HTML.
3. **Store + capital-band poison gate stay in shorted** — the poller writes to shorted's Supabase exactly as today; brandbrain never stores listing rows / addresses / PII.
4. **brandbrain owns: the queue, the agent protocol, job/run tracking + tray surface.** Its per-job payloads are tiny JSON (a suburb to crawl; a result *summary*) — so the ~2-concurrent 502 LLM ceiling does not bite (no extraction on brandbrain).

> **Note on the reviewed recommendation:** the 5-lens review recommended cuttlefish (mac-only) now + brandbrain-native *only if* an iOS Phase-0 cellular spike passes, because iOS is the weakest egress. The user has chosen B regardless — a legitimate call (owns the queue vision, dogfoods brandbrain, iOS-ready later). Recorded here for the trail; proceeding with B.

## Architecture

```
 shorted cron/daily-sync ──POST enqueue(suburbs[])──►  brandbrain  crawl_jobs (Postgres, SKIP LOCKED)
                                                        │  claim / renew / submit / list  (scoped agent tokens)
                                                        │  tray + /status surface (queued / in-progress / recent)
              ┌──────────claim job──────────────────────┘
              ▼
   collector  -mode agent  (residential Mac, launchd)
     loop: claim suburb → CDP fetch host Chrome → extract LOCALLY → capital-band gate
           → write to shorted Supabase (as today) → submit result SUMMARY → repeat
```

Distribution falls out for free: N pollers (Macs) claim from the one queue; `SKIP LOCKED` fans disjoint suburbs across them; each paces itself. (This supersedes the MVP's static shard knob for the queue path; the shard knob stays for standalone `-mode listings`/`crawl` runs.)

## brandbrain side (Go; reuses the `discovery_jobs` pattern)
- **Table `crawl_jobs`** (brandbrain's own Postgres), mirroring `discovery_jobs`: `{id, kind='housing', suburb, state, postcode, source ('rea'|'domain'|'both'), tier ('listings'|'medians'), priority, status ('pending'|'in_progress'|'succeeded'|'failed'), assigned_agent, attempts, max_attempts, lease_expires_at, result_summary jsonb, error, created_at, started_at, completed_at, updated_at}`. `result_summary` holds counts only (suburbs/listings/events/blocked_sweeps/needs_rewarm) — **never listing rows**.
- **Claim** `ClaimPendingCrawlJob(agentID)` — the exact `WITH candidate AS (SELECT id ... WHERE status='pending' AND assigned_agent IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE ... SET status='in_progress', assigned_agent, lease_expires_at=now()+lease RETURNING ...` pattern already in `discovery_repository.go:497`. Plus **`ReclaimExpiredCrawlJobs`** (requeue `in_progress` jobs past `lease_expires_at`, `attempts < max_attempts`) run on a tick or at claim time — crash resilience for a dead poller.
- **Endpoints** (hand-rolled `mux.HandleFunc`, matching `agent_handler.go`):
  - `POST /api/v1/agent/crawl-jobs` — enqueue `{jobs:[{suburb,state,postcode,source,tier,priority}], dedup_key}`. Scope: `APITokenScopeAgentUpload` (or a dedicated enqueue scope). Idempotent on `(kind,suburb,source,tier,pending)`.
  - `GET /api/v1/agent/crawl-jobs/claim` — claim one housing job. Scope `APITokenScopeAgentCrawl`. Records a heartbeat like `handlePoll`.
  - `POST /api/v1/agent/crawl-jobs/{id}/submit` — `{status, result_summary, error?}` → mark succeeded/failed. Scope `APITokenScopeAgentUpload`. Tiny payload (the 64MB cap is moot).
  - `POST /api/v1/agent/crawl-jobs/{id}/renew` — extend `lease_expires_at` for a long sweep.
  - `GET /api/v1/agent/crawl-jobs?status=&limit=` — for the tray/status surface.
- **Surface**: extend `/api/v1/agent/status` (or the GET above) so `cmd/agent/agent_state.go` + `tray.go` render a "Housing crawl" section (queued N, in-progress, last run summary).

## shorted collector side
- **New `-mode agent`** (poller): a loop — `claim` → if a job, run the **existing** single-suburb sweep (`sweepSuburbSource` / `crawlSuburb`, CDP host-Chrome, local extract, capital-band gate, `diffSuburb`/store to Supabase) → `submit` the summary → repeat until `claim` returns empty or a run cap. Reuses all crawl code; only the *driver* changes (brandbrain jobs instead of the static `crawlTargets` loop). Honors the same pacing/circuit-breaker; on a tripped breaker, `submit` with `status=needs_rewarm` (+ the exit-3 alert still fires for launchd).
- **Auth**: a scoped brandbrain agent token via brandbrain's OAuth agent-login, stored in `~/.shorted-housing-crawl.env` as `BRANDBRAIN_AGENT_TOKEN` + `BRANDBRAIN_AGENT_URL`. Poller is a no-op if unset (safe to ship dark).

## Enqueue / cadence
Jobs are **submitted to brandbrain** (matching "jobs hit brandbrain"), not owned by it: a shorted cron/`daily-sync` step (or a small `-mode enqueue`) POSTs the curated suburb catalog (`crawlTargets`, the shorted source of truth) to `crawl-jobs` on a weekly cadence. brandbrain stays a generic queue with no AU-suburb knowledge.

## Build phases (each gated, brandbrain in a worktree off `origin/main`, draft PRs, no deploy until reviewed)
- **P1 — brandbrain queue:** `crawl_jobs` migration + repo (claim/submit/renew/list/reclaim) + endpoints + tests. Test with a fake poller (curl claim/submit). *No collector, no deploy.*
- **P2 — collector poller:** `-mode agent` reusing the sweep + submit + auth env + a unit test with a fake brandbrain HTTP server.
- **P3 — enqueue:** shorted `-mode enqueue` (or daily-sync hook) posting the catalog.
- **P4 — tray/surface:** brandbrain agent tray + `/status` show housing jobs.
- **P5 — verify:** enqueue → poller claims + crawls + writes to shorted + submits → jobs show `succeeded` in brandbrain + a 2-poller run fans suburbs disjointly via SKIP LOCKED.

## Landmines
- **brandbrain `main` = 179 dirty files** (heavy concurrent WIP) → build in a **git worktree off `origin/main`**, never touch the working tree.
- **brandbrain auto-deploys on merge to main** → PRs stay **draft** until reviewed; nothing ships unattended.
- **Auth token prereq** (OAuth agent-login) — the one manual setup; poller is inert until set.
- **Reclaim is mandatory** — a poller that dies mid-sweep must have its job requeued (lease expiry), or suburbs silently stall.
- **Don't route listing rows/PII through brandbrain** — `result_summary` is counts only (Principle 3/4).
- **Keep pacing in the poller** — brandbrain has no rate limiter; the collector's jitter + breaker stay authoritative per egress IP.
