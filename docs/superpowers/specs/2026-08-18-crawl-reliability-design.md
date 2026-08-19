# Housing listings crawl — reliability programme (design)

Date: 2026-08-18
Status: proposed
Scope: the residential REA/Domain listings crawl (rig + wrappers + collector +
sentinel). Companion plan: `docs/superpowers/plans/2026-08-18-crawl-reliability.md`.

## 0. What "reliable" has to mean here

Two obligations, and both are currently unmet:

1. **The crawl must not stop silently.** Six distinct multi-day silent stoppers
   are on record (memory `housing-crawl-outage-modes`); the latest (a cache
   sweep deleting the Playwright driver) took the crawl down 2026-08-13 → 15
   while every signal said "Chrome wedged".
2. **The catalog must stay inside its freshness horizon.** Measured 2026-08-18:
   `stale>24h = 481/500`, median staleness **117h**, oldest **305h**, against a
   `CRAWL_FRESHNESS_ALARM_HOURS` of 72h.

The second is not a failure of the first. As §2 shows, the 72h horizon is
**arithmetically unreachable under the current configuration even with zero
failures** — so the programme has to renegotiate the horizon *and* raise
throughput, not just stop the bleeding.

## 1. Corrections to the brief (verified against the repo, 2026-08-18)

The brief asked for its claims to be checked. Most hold. These do not, or need
sharpening:

1. **"The delta drains ~20 jobs/round" is true but is not the ceiling.**
   `hc_drain_until_empty` (`deploy/housing-crawl-common.sh`) loops `-mode agent`
   until the queue is empty, bounded by `CRAWL_DRAIN_MAX_ROUNDS=30` — up to 600
   jobs per scheduled run. The real ceiling is the **delta selection cap**:
   `CRAWL_DELTA_MAX_SUBURBS` defaults to **60** (`crawl_delta.go:46`), so a
   daily delta refreshes at most 60 suburbs (120 jobs, split REA/Domain). That
   cap, not drain behaviour, produces the observed staleness (§2).
2. **An external daily sentinel already exists and is currently green.**
   `.github/workflows/housing-freshness.yml` (shipped in #417/#429) runs daily
   at 22:11 UTC against prod, checks ingest errors, cursor/fact period
   regressions and **72h global event silence**, and files/updates a single
   GitHub issue on failure (closing it when green). "Failures are not surfaced
   / nobody is paged" is therefore imprecise. The precise gap: the sentinel's
   crawl check is `max(observed_at)` over **all** of `property_price_events` —
   a crawl limping along at any rate keeps it green forever. It ran green on
   2026-08-14 and 2026-08-15, *during* the driver outage (silence was 34h and
   58h at those runs — under its 72h line), and it is green today with the
   catalog median at 117h. **It watches the wrong statistic**, not nothing.
   (`operations.md`'s "there is no housing equivalent" of the register/economy
   freshness workflows predates this workflow and is itself stale.)
3. **The rig-side freshness alarm is not purely log-only.** `hc_freshness`
   posts a macOS notification (`osascript`) on rc=6, and `-mode freshness`
   also annotates `crawl_run_status.freshness_oldest_hours` for `/admin`. The
   webhook (`CRAWL_FRESHNESS_WEBHOOK`) is indeed unset — verified absent from
   `~/.shorted-housing-crawl.env` and from GitHub secrets. Notifications are
   miss-able; the substantive point stands.
4. **`docs/feature/housing/pipeline.md`'s wrapper table is stale, the brief's
   schedule is right.** Installed LaunchAgents on the rig are exactly three:
   `com.shorted.housing-delta` (daily **10:00** local),
   `com.shorted.housing-full` (**1st & 15th, 08:00**),
   `com.shorted.housing-property-resolve` (21:20). The doc's 03:00/02:00 times
   and its `run-housing-agent.sh` 09:15+21:15 row describe plists that are
   **not installed**. (`run-housing-property.sh` / `run-housing-crawl.sh` are
   also uninstalled — `-mode property` is not currently scheduled.)
5. **Deploy drift is a real class but is currently reconciled.** PR #435 is
   merged (2026-08-15T08:02Z) and `~/bin/house-price-collector` reports
   `vcs.revision=1a4b73baf` — the #435 squash commit, built at the merge
   timestamp. The staged wrappers in `~/.shorted-housing-crawl-deploy/` were
   re-staged 2026-08-15. The 4h17m drift incident was real; the *mechanism*
   (hand-build, no provenance check) is unchanged and remains a design target.
6. **"A `full` row shows stale health for two weeks" needs nuance.** The
   dashboard health is cadence-aware (`crawl_jobs.go`: delta stale at 30h,
   critical at 60h; full stale at 16d, critical at 32d). A full pass that
   *fails* writes `error`/`blocked` and goes critical immediately. What stays
   invisible for ~16 days is a full pass that **never starts** — launchd
   unloaded, lock wedged, machine asleep at 08:00.
7. **Unverifiable in this repo** (brandbrain-side, accepted as observed):
   BrandBrainAgent.app strict parent coupling with no relaunch, and the
   drain-vs-auth-mint 9-second race. Both are consistent with the quoted logs
   and with `operations.md`. Their durable fixes live in the brandbrain repo;
   this design only mitigates them rig-side.

Everything else in the brief checked out: the Kasada native-startup-warm fact
(`crawl_warmcheck.go` header, `crawl_cdp.go`), the no-datacenter-bypass
instruction (`nsw_vg.go:23-26` and `deploy/README.md`), pacing defaults
20000/45000ms (`crawl.go:153-154`), `CRAWL_AGENT_MAX_JOBS=20`
(`crawl_agent.go:51`), freshness alarm default 72h (`crawl_freshness.go:38`),
exit-code contract incl. rc=8 (`crawl_env.go`), dry-run defaults, licence
posture, and the hand-deploy procedure (`deploy/README.md`).

## 2. The throughput arithmetic (the half that is not a bug)

Measured job cost: ~2.4 min/job (20–45s pacing × ~15 pages; memory
`housing-crawl-rea-truncation`). Catalog: 500 suburbs × 2 portals = 1000 jobs.

To keep every suburb younger than horizon **H** hours, the delta must re-crawl
`500 / (H/24)` suburbs per day:

| Horizon H | suburbs/day | jobs/day | crawl-time/day |
|---|---|---|---|
| 72h (current alarm) | 167 | 334 | **13.4h** |
| 120h | 100 | 200 | 8.0h |
| 168h (7d) | 71 | 143 | 5.7h |
| ~200h (implied by cap=60) | 60 | 120 | 4.8h |

The current cap of 60/day implies a steady-state rotation of ~8.3 days — which
is exactly the observed median 117h / oldest 305h once failure days are added.
**The crawl is not "failing to meet" 72h; 72h was never configured to be
met.** Meeting it needs ~13.4h of crawling every day from a single rig — the
scheduled run would finish around midnight, daily, forever. That is the wrong
trade for a fingerprint-scoped, no-proxy design where total daily exposure is
the quantity being rationed.

**Renegotiation: adopt a 120h horizon and configure for it.** Cap 120
suburbs/day → 240 jobs → ~9.6h/day (10:00 → ~19:40), rotation ≈ 4.2 days,
alarm at 120h with real margin. Pacing per request is untouched — block risk
per request is unchanged; only the daily session length grows, and the full
pass already runs ~40h sessions fortnightly without incident. The delta's
ranking (never-crawled → churniest → oldest) already makes the rotation fair,
and churny suburbs still ride the churn rule daily, so `/price-drops` — which
cares about *event* freshness, served by churn — degrades much less than the
worst-case suburb age suggests. If 9.6h/day proves too hot (blocked-rate
rising in `crawl_run_status`), the cap is one env var to walk back; the alarm
should walk with it using the table above.

The fortnightly full pass stays: it is the delisting backstop (complete sweeps
are what allow absence detection) and self-covers staleness while it holds the
single-drainer lock.

## 3. Diagnosis, in four lanes

### (a) Silent-stop failure modes

All six recorded stoppers share one shape: **an unattended run's outcome is
not observed anywhere durable, and the rig's dependencies live in state other
tooling owns.** Post-#408/#435, the residual per-mode status:

| Mode | State | Residual risk | This programme |
|---|---|---|---|
| 1. Driver deleted by cache sweep | rc=8 detects + names fix (#435) | Driver still lives in `~/Library/Caches` — the sweep class recurs | **Prevent**: relocate the driver out of prunable caches (§4, T5) |
| 2. Thin-suburb false block | Reclassified — Lane Cove North was really mode 5 | `MIN_PER_PAGE` default unchanged; low residual | Out of scope (crawl-correctness track) |
| 3. Hung drain round (`CRAWL_TIMEOUT_MIN` not enforced on the CDP pipe) | Unfixed | A hang holds the lock indefinitely; every downstream run skips | **Contain**: wrapper wall-clock watchdog per round (T3) |
| 4. Orphaned `in_progress` leases | Unfixed; crash sources reduced | Suburbs vanish from `pending` forever | Brandbrain lease-TTL is the durable fix — recorded as cross-repo follow-up, not built here |
| 5. Never-attempted job banked "succeeded" | Fixed (#192 + #408, deployed) | — | Regression watched by the sharper sentinel (T6) |
| 6a. Agent app dead after restart | Brandbrain-side, unfixed | Every run 401s until a human notices | **Surface**: rig alerting on any non-zero terminal rc (T4); relaunch fix is brandbrain follow-up |
| 6b. Drain-vs-auth 9s race | Brandbrain-side | One failed run per restart | **Mitigate**: wrapper waits for the agent's loopback port before enqueue (T4) |

### (b) Throughput vs the freshness horizon

§2. Config, not code: raise `CRAWL_DELTA_MAX_SUBURBS` 60 → 120 and
`CRAWL_FRESHNESS_ALARM_HOURS` 72 → 120 as code defaults (these modes run only
on rigs, so a code default ships with the binary and can't be forgotten in an
env file).

### (c) Observability and alerting

Three layers, each with a specific defect:

- **External sentinel** (`housing-freshness.yml`): exists, green, watches the
  wrong crawl statistic (global max event). Fix: add per-suburb catalog
  staleness (oldest covered suburb, mirroring `classifyFreshness`'s query) and
  a `crawl_run_status` health check to the same workflow. This is the only
  layer that survives every rig-side failure — including "the laptop is off" —
  because it observes prod from GitHub's side. It already has the issue-based
  notification loop; it just needs sharper eyes.
- **Rig-side alarms**: `-mode freshness` exit 6 and every wrapper failure rc
  currently end in a log + a transient macOS notification. Fix: one `hc_alert`
  helper (webhook + notification) wired to every terminal failure path and the
  freshness alarm; the webhook secret finally gets set (operator action).
- **`/admin` (`crawl_run_status`)**: honest and cadence-aware, stays pull-only
  by design — the push duty moves to the two layers above rather than teaching
  the dashboard to page.

### (d) Deploy drift between CI and the rig

The rig binary and wrappers are a hand deploy (`deploy/README.md`), invisible
to CI, with no provenance check. Two cheap moves close most of the gap:
log the running binary's `vcs.revision` at every wrapper run start (drift
becomes visible in the one log an operator reads during an incident, and in
`crawl_run_status.detail`), and a `deploy/stage-rig.sh` that builds from a
clean `origin/main` checkout, stages binary + wrappers, and offers a `--check`
mode that reports drift without writing. Full CI-driven rig deploys (a
self-updating agent) are deliberately out: the rig is one laptop, the update
path would itself become a silent-failure surface, and #435's lesson is that
fewer moving parts on the rig is the direction of travel.

## 4. Approaches considered

### Approach A — sharpen what exists: config + sentinel statistic + small hardening (recommended)

Raise the two defaults (§2); teach the existing sentinel the per-suburb
statistic; one rig alert helper on every failure path; a per-round wall-clock
watchdog; relocate the driver out of `~/Library/Caches`; provenance logging +
a staging script. No new services, no new schedulers, no schema changes, no
brandbrain changes. Every piece is testable with the suites that already exist
(`crawl_*_test.go` unit tests, `housing-lifecycle-exit.test.sh` for wrapper
behaviour).

- **For**: smallest surface that addresses every lane; the alerting spine
  (GitHub issue + webhook) reuses a mechanism already proven in this repo
  (register/economy sentinels); reversible knobs.
- **Against**: leaves the brandbrain-side fixes (lease TTL, agent relaunch) as
  follow-ups; the hung-round fix contains rather than cures (the cure is a
  watchdog inside the CDP fetch layer, a riskier change to the most fragile
  code in the collector).

### Approach B — a rig supervisor daemon

A launchd `KeepAlive` daemon owning scheduling, heartbeating to an external
dead-man's switch, watchdogging rounds, relaunching BrandBrainAgent.app,
self-updating the binary.

- **For**: one place for all rig lifecycle logic; heartbeat catches "laptop
  asleep" faster than a daily sentinel.
- **Against — rejected**: replaces launchd semantics that currently work with
  bespoke code that becomes the new silent-failure surface; most of its value
  (dead-rig detection) is already delivered by the external sentinel observing
  prod, which works even when the entire rig — supervisor included — is off.
  The 72h→120h horizon makes a daily external check sufficient resolution.

### Approach C — move reliability queue-side (brandbrain)

Lease TTLs reclaim orphans; queue-side "no claims in N hours" alerting; an
enqueue barrier until agent auth is ready; agent app relaunch.

- **For**: the *durable* fixes for modes 4 and 6a/6b genuinely live there; the
  queue sees claim behaviour no rig-side code can.
- **Against — deferred, not rejected**: cross-repo (a separate deploy train,
  `api.brandbrain.dev`), and every one of its wins is either mitigable
  rig-side for now (6b: wait-for-agent; 6a: alert loudly) or has a manual
  runbook (4: purge + re-enqueue). Recorded as follow-ups in §6 so they are
  not lost; not in this plan's scope.

### What is deliberately not worth fixing here

- **The Kasada warm cannot be automated further** — the native-startup
  requirement is a fact of the portal, not a defect (C1 already self-warms).
- **The 72h horizon is not worth meeting** — renegotiate to 120h (§2).
- **REA truncation / delisting asymmetry** — real, measured, and owned by the
  crawl-correctness track; entangling it here would double the blast radius.
- **`/admin` push alerts** — the pull dashboard plus the two push layers is
  enough; a third alert channel is noise.

## 5. Recommendation

Approach A, as nine bite-sized tasks (see the plan): two config-default bumps
(throughput + horizon), sentinel statistic fix, rig alert helper +
wait-for-agent, round watchdog, driver relocation + `-mode install-driver`,
provenance logging, staging script, and doc reconciliation. Success criteria:

- Sentinel: a catalog whose oldest covered suburb exceeds 132h turns the
  GitHub issue red within 24h — with the crawl otherwise "working".
- Staleness: median catalog age converges below ~60h and oldest below 120h
  within ~a week of the cap change (observable in `-mode freshness` output and
  `crawl_run_status.freshness_oldest_hours`).
- Any wrapper terminal failure (rc 3/4/7/8/6/other) produces a webhook message
  the same minute, not a log line.
- A repeat of the 2026-08-13 cache sweep does not touch the driver.
- `strings`-level binary drift is visible in the first ten lines of any
  scheduled run's log.

## 6. Cross-repo follow-ups (recorded, out of scope)

For the brandbrain backlog: crawl-job lease TTL (auto-reclaim `in_progress`
after ~2h — kills outage mode 4 permanently); BrandBrainAgent.app relaunch
policy (launchd `KeepAlive` or relaxed parent coupling — kills 6a); enqueue
rejection with `Retry-After` while the agent session is still minting (kills
6b at the source). For this repo, later: a wall-clock watchdog inside the CDP
fetch layer itself (cures mode 3 rather than containing it), and retiring the
fortnightly full pass if delta-at-120 plus detail-page delisting ever makes it
redundant.
