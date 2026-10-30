# Fleet-managed housing crawl: rigs fetch, shorted ingests, BrandBrain operates

**Date:** 2026-10-27
**Status:** Approved direction; implementation in progress
**Repos:** `shorted` (collector, ingest API, server jobs) + `brandbrain` (agent runtime, workload-identity issuer, control plane)
**Supersedes:** the rig deploy model in `docs/feature/housing/operations.md` ("Deploying the rig") and the secret handling in `2026-07-19-agent-bundled-housing-crawl-design.md`

## Why

Today Gamma-64's crawl runs from hand-deployed pieces:

- three launchd plists (`com.shorted.housing-{delta,full,property-resolve}`);
- bash wrappers in `~/.shorted-housing-crawl-deploy/`;
- `~/bin/house-price-collector`, hand-built and 11 collector commits behind main on 2026-10-27;
- `~/.shorted-housing-crawl.env`, holding the **prod DATABASE_URL in plaintext**.

BrandBrainAgent bundles its own collector and gets fleet upgrades through Sparkle, but nothing on the launchd path uses that copy. On top of that, the 1.33.10 app timer runs `-mode agent` with no lock.

## Owner decisions

1. **No database credential on any rig.** The rig collector only fetches. It pushes raw observations to an authenticated shorted ingest API, and every database write happens on the server.
2. **Rig authentication is service-to-service OIDC.** BrandBrain issues workload-identity tokens, and shorted verifies them against BrandBrain's JWKS. No shorted secret lives on a rig.
3. **Drift is surfaced by an alarm, and releases stay manual.** A collector behind main is flagged, and the fix is a BrandBrain release followed by `upgrade_agent`. There is no automatic release.
4. **A fleet upgrade pre-empts a running drain.** The crawl finishes its current suburb and stops, and the next drain resumes from the queue.
5. **The app relaunches when it crashes,** via a LaunchAgent with KeepAlive on crash.

## Architecture

```
shorted Cloud Run (DB + BrandBrain service identity)
  enqueue-delta 10:00 · enqueue-full 1st/15th · crawl-finalize /30m · freshness daily · property-resolve 21:20
        │ creates crawl_jobs (dispatch ledger: job ids, selection, run id)
        ▼
BrandBrain control plane ── queue · fleet heartbeat · journaled commands · alarms · Sparkle upgrades
        │ claim / renew / submit (counts only)          ▲ workload-identity issuer (OIDC discovery + JWKS, ES256/KMS)
        ▼                                               │ POST /api/v1/agent/workload-token {audience}
BrandBrain runtime on the rig (Go) ── schedules drains, single-flight, watchdog, health, commands
        │ spawns bundled collector (no DATABASE_URL in env)
        ▼
housing-crawl-collector -mode cycle ── lock · preflight · drain rounds (child -mode agent, events on CRAWL_EVENTS_FD) · summary
        │ PushSweep (Connect, JWT aud=https://api.shorted.com.au/housing-ingest)
        ▼
shorted CrawlIngestService ── verify JWT · allowlist · re-derive · quarantine · diff/store (services/pkg/housingcrawl)
```

**Ownership:**
- **shorted** owns the crawl's meaning: which suburbs to crawl, how sweeps diff, events, delisting, freshness, the database and the exit-code contract.
- **BrandBrain** owns operations: scheduling drains, supervising processes, health, commands, alarms, upgrades and identity. It stays counts-only: job metadata (suburb, state, postcode, source) and counts, never listing rows.

**Data that must never reach BrandBrain:** listing rows go only to `api.shorted.com.au`. Two existing leak paths are closed:
- `-mode crawl` posting search-page HTML to BrandBrain's ExtractRealEstate is removed from the rig binary;
- collector output is written only to a separate local `housing-crawl.log`, never to `agent-runtime.log`, which `collect_runtime_logs` uploads.

### Where each mode runs

| Mode | Where | Why |
|---|---|---|
| enqueue delta/full | shorted server | It reads catalog freshness from the database |
| listings drain | rig fetches, then `PushSweep` | Needs warm Chrome on a residential IP (Kasada) |
| sal-link, MV refresh, revalidate, freshness, `crawl_run_status` | shorted server | Database work. `crawl-finalize` runs every 30 minutes when data changed |
| property-resolve | shorted server; fallback is rig fetch-and-push | No browser or residential IP needed (REA public autocomplete) |
| property (AVM) | rig fetches; `GetPropertyWorklist` / `PushValuations` | Needs warm Chrome. Phase 3 |
| vg-nsw (and vg-vic) | rig uploads the raw zip to a shorted-signed GCS URL; the server parses it | Residential IP only; public data. Phase 3 |

## Contracts

### Collector CLI (rig)

- `-mode cycle -job drain|repair|preflight [-dry-run] [-max-duration 10h]` (S2, `crawl_cycle.go`). It runs only with `CRAWL_SINK=ingest`; `db`, `shadow` and unset refuse with exit 8.
  - **drain** runs these steps in order:
    1. take the lock (exit 12 if held). A child of the holder passes, as in `crawl_lock.go`, but the cycle itself must be the holder: a lock held by its parent is exit 12, never a passenger run;
    2. preflight: driver (install it once if missing; a second failure or a failed install is 8), Chrome warm (the existing `ensureChromeWarm`, CDP only; unusable is 4), and `ProbeAuth` against ingest (13, 14, 15, 8 or 7, the S-FETCH mapping);
    3. run drain rounds, each a child `-mode agent` re-exec'd in its own process group, with its events on a pipe at `CRAWL_EVENTS_FD`, its stdout and stderr passed to the cycle's stderr, and `CRAWL_CYCLE_ID` and `CRAWL_RUN_ID` set to the cycle id. The round policy is decided on the child's events and exit code, never on log text:
       - `CRAWL_DRAIN_MAX_ROUNDS` (default 30; a value of 0 or less is refused with exit 8);
       - `CRAWL_DRAIN_NO_PROGRESS_ROUNDS` (default 3): after that many consecutive rounds with no succeeded job, the drain stops with outcome `no_progress` and exit 0, and the runtime alarms on it. This also catches a deferral spin, where jobs are claimed and deferred but none succeeds (for example `CRAWL_AGENT_BLOCK_TRIP` above `CRAWL_CIRCUIT_TRIP`);
       - a round with 0 claims and 0 processed is queue empty (done, 0);
       - 3 or 5 cool down `CRAWL_REWARM_COOLDOWN_SEC` (900) and retry, at most `CRAWL_REWARM_MAX_RETRIES` (2), then stop with that code;
       - 8 installs the driver once, retries the round once, then stops with 8;
       - 4, 7, 12, 13, 14 and 15 stop with that code, and 10 stops with 10;
       - 11 (hung): see below.
       - **Budget (`-max-duration`):** at the deadline no new round starts and the running child gets its graceful stop. A child code of 0 or 10 ends the run as `budget` with exit 0. Any other child code is kept: a routine re-warm code (3 or 5) ends as `stopped` with that code and starts no cooldown, and the runtime owns the 2 h backoff.
    4. write one summary JSON line to stdout. Logs go to stderr.
- **repair** takes the lock, forces install-driver (atomic, see below), warms Chrome and runs warmcheck. If the warm check fails or stalls, it runs the wedged-Chrome recovery (the rc 4 path) and checks once more. Exit 0 (repaired), 4 (not warm), 8 (environment broken), 7 (lock directory cannot be created), 10 (cancelled), 11 (a step hung), 12 (lock held) or 1 (internal error).
- **preflight** is NON-mutating and takes no lock. It reports the lock (`free`, `held_elsewhere` or `unknown`; the holder's pid is never reported), the driver, Chrome reachability (`reachable`, `unreachable` or `port_conflict`, read-only: no warm, no launch, no fetch; `port_conflict` means another process holds the CDP port, see the `chrome` bullets below; `unknown` when the fetch mode is not CDP or the check stalls) and ProbeAuth. It claims nothing and installs nothing. It exits 0 whenever its checks ran, with the health in the summary, and exits non-zero only for an invalid configuration (8) or an internal error (1).
  - **Hung (11):** a child that emits no event for `CRAWL_HUNG_AFTER` gets SIGTERM to its process group, then SIGKILL after `CRAWL_HUNG_GRACE` (default 60s). The cycle exits 11. Fetch events are emitted per page, and start-up work emits `startup` events (`probe_auth`, `warm_probe`, each start and done), so silence means real silence.
- **`CRAWL_HUNG_AFTER`:** default `max(20m, the worst silence)`. The worst silence is the sum of the silences the child can really have, with the defaults in brackets: 2 sources × 3 fetch attempts × `CRAWL_FETCH_TIMEOUT_S` (360 s); one CDP reconnect (120 s, an estimate, since playwright-go sets no timeout on the driver start and attach); the CDP watchdog, `CRAWL_CDP_WATCHDOG_S` or 3 × the fetch timeout (180 s); the widest page pace, 3 × `CRAWL_LISTINGS_PAGE_MAX_MS` (60 s); a push's retries, 3 × 60 s + 3 s (183 s); and the gap between suburbs, `CRAWL_MAX_DELAY_MS` (45 s). That is 948 s, so the 20-minute floor applies. Both the explicit value and the derived value are clamped to `30m − CRAWL_HUNG_GRACE − 5 s drain − 1m margin` (1675 s with the defaults), so the cycle's kill lands below the runtime's 30-minute watchdog. The clamp logs once.
  - **Parent death:** the cycle checks its parent every `parentCheckInterval` (1 s) while supervising or cooling down, and before each round, the drain's preflight and each repair step. A PPID of 1 means the runtime died: the cycle sends ONE SIGTERM to the round and finishes it, then exits 10 with its summary, and starts no new round. A broken cycle events fd is the same stop.
- **Bounded steps:** each preflight and repair step runs under its own timeout and the cycle's context, so a deadline or a signal ends it at once. A step that misses its timeout gets a grace of 30 s to answer with its own code, and that code is the answer (a ProbeAuth that answers 14 in the grace is 14, not a hang). Only a step still silent after the grace is hung (11). The timeouts follow their budgets: driver install 6 min; ProbeAuth 4 min (its worst case is 3 × 60 s + 3 s = 183 s); Chrome: the step computes to 2006 s, about 33 min (launch 30 s, plus 3 warm probes of 612 s each, plus 2 recoveries of 70 s each), and is clamped to the 27m55s ceiling (1675 s). Each warm probe is bounded on its own at 612 s (2 × (reconnect 120 s + watchdog 180 s) + settle 12 s), and a warm check is 612 s. When every warm probe stalls, the Chrome step returns 4 (unusable) from the probes' own bounds, or 11 (hung) when the step deadline fires first during an uninterruptible Chrome recovery. It is never 0. Each step announces itself with a `phase` event, so the runtime's silence is one step plus its grace, never the sum of the steps.
  - **SIGTERM/SIGINT:** the first signal sends one graceful SIGTERM to the child's PID (never the group); the child finishes its suburb and exits 10, and the cycle exits 10. A second signal SIGKILLs the child's group and exits with the code already decided (10 for a stop).
  - **`-max-duration`:** at the deadline no new round starts and the running child gets the SIGTERM above. The cycle exits 0 with outcome `budget`, unless the child returned a worse code.
  - **Output:** stdout is exactly one summary JSON line in the shape of "Cycle output contract (schema 1)" below. IDs, enums and counts only. Stderr carries the logs.
- **Graceful stop:** ONE SIGTERM, to the child's PID only (never the group), sent once the child has reported `ready`. For a child that never reports ready (an older collector), the SIGTERM is sent at the 120 s ready wait if a stop is pending. A second signal SIGKILLs the child's group and exits with the decided code. A child that dies of a signal while a stop is pending exits 10; a signal death with no stop is internal (1).
  - **Driver install (batch 6):** `-mode install-driver` (and the cycle's install and repair) is a NO-OP when the live driver verifies: the library's version, `package/package.json`, a manifest of the package's file count, and `node cli.js --version` (no download, no swap, the same inode). `-force` reinstalls. An install writes into a sibling temp directory, verifies it, and renames it into place, so a killed install never leaves a half-written driver. Every install takes `<driver-dir>.install.lock` (flock); a second installer waits up to 15 min, then exits 8. Inside a cycle the wait is bounded to the install step's 6 min less 30 s, so a cycle stuck behind another install exits 8 before its step deadline (11). A legacy driver dir installed by an older collector has no manifest, so the first install re-downloads it once: the first OFFLINE staging after the upgrade exits 1 (the live dir is untouched), and later offline runs are no-ops. Leftover temp and old directories are removed only when their owning pid is not alive. `stage-rig.sh` runs install-driver on every staging, so an offline staging of a good driver exits 0.
  - **`CRAWL_HUNG_GRACE`** must be between 10 s and 5 m; any other value is refused with exit 8 (outside that range the hung ceiling shrinks towards zero, or the kill never completes).
- **Dry run:** `-dry-run` OR `CRAWL_DRY_RUN=true`. A dry run runs one round and sends no ReportCycle at all. The child is always told `CRAWL_DRY_RUN` explicitly.
  - **ReportCycle:** each child round reports its own counts-only row with `run_id = cycle_id`, and the server accumulates rounds that share a run id, as the bash drain's `CRAWL_RUN_ID` does. The cycle sends a zero-count gap report only for a round that hung, or that exited without a `round_done` and was not stopped by the cycle, and once for a preflight that fails with 4, 8 or 15 (ingest is reachable). It sends none for 12 (the legacy drainer holds the lock in shadow), or for 13 and 14 (which cannot report).
  - **Process groups:** the children are group leaders. Chrome launched by the collector runs under `Setsid`, a session of its own, so the group kill does NOT reach the warm browser. This is deliberate: the warm profile must survive a cycle. The Playwright driver and any fetcher-owned process stay in the child's group and are killed with it.
- `-mode version` prints `{"revision","modified","source","go"}`. It needs no environment.
- The agent and cycle modes run **without `DATABASE_URL`**.
- **Round events** are NDJSON on `CRAWL_EVENTS_FD`: `claim`, `page`, `fetch`, `submit`, `ingest_ok`, `ingest_error`, `shadow`, `shadow_circuit`, `finalize_started`, `round_done`. They carry IDs, counts, enums and Connect code words only, never message text. `fetch` is `{job_id, source, page, outcome: ok|blocked|error}`, one per page fetch (added by S2, so a dense sweep proves the child is alive; the hung timer runs off it). `ingest_ok` is `{probe: false, job_id, source, applied, replayed, quarantined}` for each accepted push; `quarantined` is true when the server held the sweep back. `ingest_error` is `{probe: false, code}` for each failed push, where `code` is a word of the contract's closed set. `shadow` is the per-sweep parity record. `shadow_circuit` is written once, when shadow switches off after three consecutive dry-run failures.
- **Start-up events (added by S2):** `ready` is written first, once the SIGTERM handler is installed (`runAgent` installs it before anything slow). `startup {step: probe_auth|warm_probe, stage: start|done, outcome}` brackets each start-up step; `outcome` on `done` is `ok` or an ingest code word. A warm probe's `outcome` is `warm`, `cold`, `unusable` or `env_broken`; `outcome` is present only on `stage: done`. `ProbeAuth`'s own answer is `ingest_ok {probe: true}` or `ingest_error {probe: true, code}`, with the contract's words.
- **Events come only from the work loop, never from a timer.** The parent check and the page check are checks, not events.
- **Cycle events** on the cycle's own `CRAWL_EVENTS_FD` are the contract's events (see "Cycle output contract (schema 1)" below): `cycle_start`, `phase`, `preflight`, `round_start`, `round_done`, `ingest_ok`, `ingest_error`, `cycle_done`. Every event carries `type`, `ts` and `cycle_id`. Forwarded child events keep their own fields, gain `type`, `cycle_id` and `round`, and never include the child's `ready` or `round_done`. The cycle's writes go through a bounded queue with one writer, so a slow or stalled events fd drops and counts events (`counts.events_dropped`) and never stalls supervision.
- **Lock:** the same lockdir as bash's `hc_acquire_lock`, so a Go holder and a bash holder exclude each other. A child of the holder may pass; the cycle itself must be the holder.
- **Deliberate db-path behaviour changes (batch 5):** (a) a db round whose bash wrapper dies now stops at the next page: the sweep it was in is abandoned as incomplete, its job is failed and retried, and its write is rolled back. (b) A SIGTERM during start-up exits 10 instead of dying by signal, because the handler is installed first. (Item (a)'s rollback is the intended behaviour; the transaction boundary of a db sweep is not re-verified in this doc.)
- **SIGTERM:** finish the current suburb (including its push), then exit 10.

**Exit codes:**

The table below is the history of the exit codes. Where it conflicts with the contract's runtime policy table (rc 4, 10 and 12 in particular), the contract wins.

| rc | Meaning | Runtime action |
|---|---|---|
| 0 | ok | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 1 | internal error: a panic, or a child exit code the table does not know | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 3 / 5 | re-warm budget spent / Kasada stub | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 4 | Chrome unusable | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 7 | agent infrastructure failed (including a BrandBrain mint outage) | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 8 | environment broken | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 10 | cancelled | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 11 | hung (the cycle killed a child round that emitted no event for `CRAWL_HUNG_AFTER`) | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 12 | skipped: lock held | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 13 | ingest auth refused | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 14 | ingest unavailable | defers to the contract's runtime policy ("Runtime exit-code policy") |
| 15 | ingest contract (collector too old or schema mismatch) | defers to the contract's runtime policy ("Runtime exit-code policy") |

Never retried automatically: 8 (after its one repair), 10, 12, 13 and 15, plus WAF 403s. Portal blocks inside a drain are handled only by the circuit breaker's deferral. **Circuit and retries:** the runtime's policy is in "Runtime exit-code policy" under the contract (the retries run first; 3 and 5 share one row; a backstop opens the circuit after 6 consecutive failed runs among the circuit codes). The rows above are its history.

### Cycle output contract (schema 1)

The collector (`-mode cycle`) produces this contract, and BrandBrain's runtime consumes it. Both sides
use exactly these names and closed value sets. A value outside a set is a bug: the runtime records
`unknown` and logs the field name, never the value. Every field is an ID, enum, count, bool or
RFC 3339 timestamp. No listing data appears anywhere.

**Summary: exactly one line on stdout, always the last and only stdout line, in every exit path
(including refusals, panics and flag errors).**

```json
{
  "schema": 1,
  "cycle_id": "string",
  "job": "drain | repair | preflight | unknown",
  "dry_run": false,
  "outcome": "<see below>",
  "exit_code": 0,
  "rounds": 0,
  "started_at": "RFC3339",
  "finished_at": "RFC3339",
  "collector": {"revision": "string", "modified": false},
  "lock":   "free | held_by_cycle | held_elsewhere | unknown",
  "env":    {"driver": "ok | installed | missing | unknown",
             "chrome": "warm | reachable | unreachable | unusable | port_conflict | unknown"},
  "ingest": {"probe": "ok | unauthenticated | permission_denied | unavailable | contract | token | not_run",
             "last_ok_at": "RFC3339 | null"},
  "counts": {"claimed": 0, "succeeded": 0, "failed": 0, "deferred": 0, "blocked": 0,
             "pushed": 0, "push_failed": 0, "quarantined": 0, "events_dropped": 0}
}
```

- **`exit_code`** equals the process exit code in every path.
- **`outcome`** values:
  - drain: `queue_empty | budget | no_progress | max_rounds | cancelled | lock_held | preflight_failed | stopped | hung | internal_error`;
  - repair: `repaired | repair_failed | lock_held | cancelled | internal_error`. A hung repair step is `repair_failed` with exit 11;
  - preflight: `checked | preflight_failed | cancelled | internal_error`. `preflight_failed` is used only for a configuration refusal (exit 8);
  - a configuration refusal in drain is `preflight_failed` with exit 8. A dry-run drain runs one round and ends `max_rounds`.
- **Outcomes the runtime records** (in the heartbeat's per-job `last`, not printed by the collector): a repair that the runtime's own repair time limit stopped (`-max-duration`, 45 min) is recorded as `budget`, distinct from an operator `cancelled`. The repair outcome set in the heartbeat is therefore the list above plus `budget`.
- **Heartbeat `jobs.<job>.enabled`** is the operator SETTING (for drain: not disabled by `housing_crawl_configure {job: drain, enabled: false}`), not "will run now". Scheduled drains run only when the state is `active` and the setting is on. Alarms and dashboards must read it that way.
- **Event naming:** every event, forwarded child events included, carries `type`. Consumers key on `type` only. Forwarded child events may also keep their legacy `event` key.
- **`chrome`:**
  - `warm` only when a real warm check passed (a drain preflight or repair);
  - `reachable` means the `/json/version` endpoint answered and nothing more;
  - `unreachable` means no Chrome answered.
  - `port_conflict` means a process that is not the dedicated-profile Chrome holds the loopback CDP port, or the port answers while no process on it is visible and no dedicated Chrome runs (another user's process). The collector neither launches over it nor kills it, and the cycle exits 8. It is set by the drain and repair preflight, a round's exit 8, the repair's recovery and the read-only preflight. It never means the Chrome is wedged or unusable.
- **`ingest.probe`** uses the same code words as the `ingest_error.code` event.
- **`counts`** keys are exactly this set; there are no others.

**Exit codes added to the design table:**
- `1`: internal error. A panic, or a child exit code the table doesn't know. The runtime retries at the next slot and raises an alarm after 3 consecutive.
- `-job preflight` exits 0 whenever its checks ran, because it is health-only and reports health in the summary. It exits non-zero only when it could not run at all: invalid configuration (8) or an internal error (1).

**Events (NDJSON on `CRAWL_EVENTS_FD`), schema 1.** Every event carries `{"type", "ts", "cycle_id"}`. Forwarded child events also carry `"round"`.

| type | extra fields |
|---|---|
| `cycle_start` | `job`, `dry_run`, `collector{revision, modified}` |
| `phase` | `name: preflight \| round \| cooldown \| install_driver \| repair \| stopping`, `until` (RFC 3339, for `cooldown` only) |
| `preflight` | `lock`, `env{driver, chrome}`, `ingest{probe}` (same value sets as the summary) |
| `round_start` | `round`, `pid`, `pgid` |
| `round_done` | `round`, `exit_code`, `counts{...same keys...}`. Counts are for THIS round only (including `events_dropped`). The summary holds the totals. Every `round_start` has a matching `round_done`, including on panic (`exit_code` 1). |
| `ingest_ok` | `probe` (bool: true for a ProbeAuth result, false for a push). Push only: `job_id`, `source` (`rea \| domain`), `applied`, `replayed`, `quarantined` (bools). |
| `ingest_error` | `probe` (bool) and `code`, one of `ok \| unauthenticated \| permission_denied \| unavailable \| contract \| token \| invalid_argument \| resource_exhausted \| failed_precondition \| already_exists \| not_found \| unimplemented \| canceled \| internal \| deadline_exceeded \| transport \| unknown \| other`. `ingest.probe` in the summary uses the subset `ok \| unauthenticated \| permission_denied \| unavailable \| contract \| token \| not_run`. |
| `startup` (child) | `step` (`probe_auth \| warm_probe`), `stage` (`start \| done`), `outcome`. For `probe_auth`, `outcome` is `ok` or an `ingest_error` code word. For `warm_probe`, it is `warm \| cold \| unusable \| env_broken`. `outcome` is present only when `stage` is `done`. |
| `cycle_done` | `outcome`, `exit_code` |
| child work events (`claim`, `fetch`, `page`, `submit`, ...) | unchanged; IDs, enums and counts only |

**Silences and watchdogs:**
- The longest legitimate silence on the cycle's own fd is a cooldown. A `phase` event marks it, and its `until` gives the end.
- The runtime's watchdog deadline is `max(last_event + 30m, cooldown_until + 5m)`.
- On a watchdog or pre-emption kill, the runtime signals BOTH the cycle's process group and the current round's `pgid` from `round_start`.
- The collector's own child watchdog is `CRAWL_HUNG_AFTER` (derived from `CRAWL_FETCH_TIMEOUT_S`) plus `CRAWL_HUNG_GRACE`. It must stay below the runtime's 30 minutes; the doc states the arithmetic.

**Runtime exit-code policy (clarifies the design table):**

| rc | Runtime action |
|---|---|
| 0 | next slot |
| 10 | next slot; not a failure. This also covers pre-emption and a stop on a state change. |
| 1 | next slot; alarm after 3 consecutive |
| 3 / 5 | one retry after 2 h |
| 4 | retry after 30 min |
| 7 | retries at 5, 15 and 45 min |
| 11 | one retry after 30 min |
| 14 | retry after 30 min, then 2 h; then the circuit opens, raising `ingest_unavailable` |
| 12 | next slot; 3 CONSECUTIVE 12s raise `legacy_conflict`; no circuit |
| 8 | pause the job immediately (`env_broken`) |
| 13 | pause the job immediately (`ingest_auth`) |
| 15 | pause the job immediately (`drift`) |

- **Circuit for 3/5, 4, 7, 11 and 14:** opens after 3 consecutive failed runs among these codes, but only once the latest failing code's own retry schedule is EXHAUSTED. A code's scheduled retries always run before the circuit opens. Example: 7 runs its 5, 15 and 45 min retries, and the circuit opens only if the 45 min retry also fails. 3 and 5 are ONE row and share one schedule. A change of code does not restart a schedule that is already exhausted. As a backstop, the circuit opens unconditionally after 6 consecutive failed runs among these codes, whatever the schedules. A success resets every streak. Exit 10 changes nothing.
- **"Pause the job":** it does not run at later slots. Pauses and open circuits stay closed to later slots and clear only on:
  - an operator `housing_crawl_run` or `housing_crawl_repair` (B5), or the interim local reset endpoint;
  - a collector revision change. This clears `drift`, and also any pause or circuit opened under the previous revision.
- **Persistence:** circuit state, pauses, retry timers, streaks and `last` survive runtime restarts, stored on disk. A restart never runs a job earlier than its `retry_at` or next slot.

**Stopping (runtime ↔ cycle):**
- **Graceful stop:** ONE SIGTERM to the cycle's pid. The cycle forwards one SIGTERM to the round's pid; the round finishes its suburb and push, then exits 10.
- **Escalation:**
  - watchdog: SIGTERM, then SIGKILL after the grace period;
  - pre-emption timeout: SIGKILL;
  - in both, SIGKILL both the cycle's process group and the current round's `pgid` from `round_start`.
- **Parent death:** if the cycle's parent (the runtime) dies, the cycle behaves as on SIGTERM: it lets the round finish its suburb, then exits 10. Likewise, a round whose parent (the cycle) dies or whose events fd breaks stops within one page. So the runtime may exit without waiting for the cycle.
- **Orphan at startup:** a runtime that starts while an orphaned collector still holds the lock reports `in_flight.phase = orphan_finishing` and waits. It does not count the resulting 12s.

**Environment the runtime must pass explicitly:**
- `CRAWL_PW_DRIVER_DIR=~/.shorted-housing-crawl/pw-driver`, the same directory the bash wrapper uses. Never `~/Library/Caches`, which a cache sweep emptied in the 2026-08-13 outage.
- `HOUSING_CRAWL_CHROME_PROFILE`, plus the same Chrome and CDP settings the wrapper sets.
- `CRAWL_DRY_RUN` as `true` or `false`, always set.

### Ingest API (shorted)

`shortedapi.housingingest.v1.CrawlIngestService` (Connect, binary + gzip):
- It gets its own handler and interceptor chain, separate from the public chain.
- It is not `VISIBILITY_PUBLIC`, so it never appears in API docs or MCP.
- It should be a separate Cloud Run service built from the same image, so the public API's connection pool stays isolated.

**Methods:**
- `ProbeAuth` returns `{subject, min_collector_revision, server_time}`.
- `PushSweep` takes one suburb × source per call. That is the atomic unit for delisting safety.
- `ReportCycle` takes `{cycle_id, outcome, exit_code, counts}`.
- Phase 3: `GetPropertyWorklist`, `PushValuations`, `CreateArtifactUpload`, `CommitArtifact`.

**`PushSweepRequest`:** `idempotency_key`, `job_id`, `attempt`, target `{suburb, state, postcode}`, `source` (rea|domain), `status` (COMPLETE|PARTIAL|BLOCKED), `pages`, page meta, `observed_at`, the listings (the `RawListing` fields), `collector_revision` and `dry_run`.

**Response:** counts only, never listing fields.

**Limits:** request body at most 4 MiB; at most 2,000 listings and 50 pages per sweep; caps on every string field.

**Idempotency:**
- The key is `<job_id>:<attempt>:<source>`, stored in `crawl_ingest_receipts(key, rig_id, body_sha256, response)` for 14 days.
- Same key and same hash returns the stored response; same key with a different hash returns `AlreadyExists`.
- The rig pushes BEFORE it submits to BrandBrain. It retries a push up to 3 times and renews its lease while it does.
- `missed_sweeps` increments at most once per region per 12 hours, so a re-swept job can't speed up delisting.

**Trust boundary:** the server re-derives what matters instead of trusting the rig:
- `runTs` is the server's receive time;
- `AddressKey` comes from the canonical target;
- sanitize, target-match and price clamping run again on the server;
- the job must be in the dispatch ledger with a matching target and source.

**Limits on a compromised rig:**
- a per-rig rate limit of 120 sweeps an hour;
- **quarantine** holds a sweep back and alerts when more than 25% of its listings move more than 10%, or when it would delist more than 25% of active listings (or more than 20);
- an empty COMPLETE sweep is accepted only when the portal reports zero results;
- every row is stamped with its receipt ID, so a bad rig's writes can be reverted surgically;
- kill switches: removal from the allowlist, a `housing_ingest_rigs.enabled` flag, and BrandBrain refusing to mint.

A compromised rig cannot read anything back, cannot push for suburbs that weren't dispatched, and cannot touch other tables.

**Outcome mapping:**

| Situation | Rig pushes | Rig tells BrandBrain |
|---|---|---|
| Blocked sweep | `BLOCKED` with no rows | `failed` |
| Circuit open, not attempted | nothing | `deferred` |
| Ingest unavailable | (push failed) | `deferred`, retry after 15 min |
| Ingest rejected | (push refused) | `failed` |

### Workload identity (BrandBrain issues, shorted verifies)

**The issuer is separate from the MCP OAuth server**, which is authorization-code only, uses opaque tokens and takes its issuer from the request host. Its details:
- `iss` is `https://api.brandbrain.dev/workload`;
- discovery is at `/workload/.well-known/openid-configuration`, and the key set at `/workload/jwks.json`;
- signing is ES256 with a Cloud KMS asymmetric key, so the private key never leaves KMS; `kid` is derived from the key version.

**Minting:** `POST /api/v1/agent/workload-token {audience}`.
- It is authenticated with the agent bearer token and needs the `agent:crawl` scope.
- The audience must be on an allowlist; the rig must hold `housing_crawl_v1` and be in an active admin state.
- At most 30 mints an hour per rig, each audited.
- A desktop rig signed in with a user session maps to `sub` through heartbeat attribution, never through `X-Agent-ID` alone. Enrolling a rig with a rig token is stronger.

**Claims:**
- header `{alg: ES256, kid, typ: JWT}`;
- `iss`, `sub: "rig:<id>"`, `aud: "https://api.shorted.com.au/housing-ingest"`;
- `iat`, `nbf = iat`, `exp = iat + 600`, `jti`;
- `org` (a configured constant), `rig_type`, `agent_version`.

No personal data.

**Refresh:**
- The runtime re-mints when less than 3 minutes remain.
- The collector calls the loopback `GET /control/v1/workload-token?audience=…` when less than 60 seconds remain, and once more on a 401.
- **Loopback response shape (the contract, matching BrandBrain's issuer):** `{"token": "<JWT>", "expires_at": "<RFC 3339>", "audience": "<audience>"}`. The collector requires `token` and `expires_at`, and it requires `audience` to equal `https://api.shorted.com.au/housing-ingest`. It also checks that the token is three base64url segments. A missing field, an audience mismatch or a malformed token ends the round with exit 7 (agent infrastructure), and the error never carries the token. Any other shape, including the older `access_token` and `expires_in` variants, is refused.
- The loopback endpoint issues only allowlisted audiences and never logs the token.
- Every HTTP client the collector uses refuses redirects, so a 307 never re-sends the body or the bearer. The control port is a number in 1..65535, and the control URL is always `http://127.0.0.1:<port>`.

**Verification on shorted (`services/pkg/workloadauth`, golang-jwt v5):**
- Discovery is fetched at startup, and the key set is cached per `Cache-Control`.
- An unknown `kid` triggers a refetch at most once a minute.
- If BrandBrain is unreachable, the cached keys are used for 24 hours, after which verification fails closed with `Unavailable`.
- Checks:
  - ES256 only;
  - exact `iss` and `aud`;
  - `exp` and `nbf` with 60 seconds of leeway;
  - `exp − iat ≤ 900`;
  - `sub` on the allowlist and `org` matching.
- `HOUSING_INGEST_DENY_KIDS` is an emergency kill list.

**Rotation:** a new KMS version every 90 days, published 7 days before it starts signing. The old version is kept at least 24 hours after its last use.

### Fleet surface (BrandBrain)

- **Heartbeat** `resources.housing_crawl` (schema 1):
  - `state`: disabled|shadow|active;
  - `collector{revision, modified, app_version}`;
  - `env{driver, chrome}`;
  - `lock`;
  - `legacy_scheduler`;
  - `in_flight{phase, round, last_progress_at}`;
  - `circuit`;
  - `ingest{last_ok_at, last_error_code, token_expires_at}`;
  - per job: `{enabled, next_run_at, retry_at, last{outcome, exit_code, finished_at, counts}}`.

  This needs no migration (the `agent_telemetry` precedent).
- **Commands** (journaled management kinds):
  - `housing_crawl_run {job: drain|repair|property|vg-nsw, dry_run}` succeeds once the collector is spawned; the outcome comes through the heartbeat;
  - `housing_crawl_cancel`;
  - `housing_crawl_repair` (install-driver, then ensure Chrome is warm, then warmcheck; needs an idle rig; timeout 6 minutes);
  - `housing_crawl_configure {state | job+enabled}`, which refuses `active` while legacy plists are loaded.

  Run-now for delta or full enqueue is shorted's `/api/admin/jobs/run`.
- **Storage and alarms:**
  - Migration `063`: `rig_housing_crawl_runs`, and `rig_housing_crawl_alarms` with kinds stale, failing, env_broken, drift, legacy_conflict and ingest_auth.
  - The evaluator raises an alarm when a rig is offline while a drain is due.
  - Prometheus gauges and a webhook.
- **Drift:** the release manifest is compared with shorted main, counting only commits under `services/house-price-collector/`. An unreachable GitHub reports `unknown`, never `current`.

## PRs

**shorted:**
- **S0** `-mode version` and ldflags.
- **S1** round events, graceful SIGTERM and the shared lock.
- **S-LIB** moves the diff, store and validation into `services/pkg/housingcrawl`, with no behaviour change.
- **S-AUTH** the `workloadauth` verifier.
- **S-ING** proto, service, migration (`crawl_dispatch`, `crawl_ingest_receipts`, `housing_ingest_rigs`, receipt IDs on rows) and quarantine.
- **S-SRV** server job modes and Terraform schedules.
- **S-FETCH** the ingest sink, no `DATABASE_URL`, lease renewal, and removing ExtractRealEstate.
- **S2** `-mode cycle`.
- **S4** shadow parity: the legacy collector dry-run pushes before its local diff.
- **S-P3** property and vg.
- **S5** docs.
- **S6** deletes the wrappers, plists, `stage-rig.sh` and the rig database sink, 14 days after cutover.

**brandbrain:**
- **#468** bundles the collector from a shared clone of shorted origin/main and writes a full-SHA `.version`.
- **B9** workload-identity issuer.
- **B10** shorted's Cloud Run job service account calls the enqueue, purge and summary routes with a Google-signed ID token; no stored secret.
- **B2** runtime controller: no secret; spawns with `SHORTED_INGEST_URL`; serves the loopback token endpoint.
- **B3** Swift UI on runtime state; delete the DB-URL card and the Keychain item.
- **B4** heartbeat domain and capability `housing_crawl_v1`.
- **B5** commands.
- **B6** migration 063, alarms, webhook, metrics.
- **B7** drift.
- **B8** CRM and MCP.
- **B11** LaunchAgent with KeepAlive on crash.

**Order:**
- shorted: S0 → S1 → S-LIB → S-AUTH → S-ING → S-SRV → S-FETCH → S2 → S-P3 → S6.
- brandbrain: B9 and B10 deploy first, then the B2 + B3 + B4 release, then B5, then B6–B8.

## Gamma-64 cutover

**Prerequisites:**
- shorted server PRs deployed, with their schedules **paused**;
- B9 and B10 deployed;
- the rig on the ingest allowlist.

**Steps:**
1. Confirm the 1.33.10 app timer is off.
2. `upgrade_agent` with the controller disabled. Check the collector revision, that `legacy_scheduler` lists the 3 plists, and that `ProbeAuth` succeeds.
3. Run shadow parity for 3 days, using one last `stage-rig.sh` deploy. Target at least 99% event parity with nothing quarantined.
4. Dry-run property-resolve from Cloud Run once.
5. After a delta drain finishes, `launchctl bootout` the three plists and move them aside.
6. Unpause the server schedules.
7. Send `configure active`, then `housing_crawl_run {job: drain}`.
8. Run 72 hours with no 13, 14 or 15 and the sentinel green.

**Rollback (any time before step 9):**
- `configure disabled`;
- pause the schedules;
- re-bootstrap the plists.

**Step 9, on day 14 (after a full pass):**
- Delete:
  - `~/.shorted-housing-crawl.env` and `~/.shorted-housing-vg.env`;
  - `~/bin/house-price-collector` and the staged wrappers;
  - the plists and the Keychain item.
- Check that no `DATABASE_URL` remains under the home directory.
- Keep the driver directory and the Chrome profile.

## Open questions

- **Dispatch ledger.** BrandBrain's enqueue must return the IDs of jobs it de-duplicated. Not yet verified.
- **Addresses to the rig.** The AVM worklist and the property-resolve fallback send addresses from shorted to the rig. The rig already sees these when it scrapes.
- **Rig token for Gamma-64.** Enrolling it with a rig token gives a stronger `sub` than heartbeat attribution.
- **Quarantine thresholds.** They need tuning against history to avoid false positives during real market moves.
- **Lease renewal.** A dense suburb's sweep plus push retries is close to the 10-minute lease, so the collector has to renew it.
