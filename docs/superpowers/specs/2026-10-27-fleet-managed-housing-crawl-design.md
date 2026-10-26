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

- `-mode cycle -job drain|repair [-dry-run] [-max-duration 10h]` runs these steps in order:
  1. take the lock;
  2. preflight: driver (install it once if missing), Chrome warm, and `ProbeAuth` against ingest;
  3. run drain rounds, each a child `-mode agent` in its own process group;
  4. write one summary JSON line to stdout. Logs go to stderr.
- `-mode version` prints `{"revision","modified","source","go"}`. It needs no environment.
- The agent and cycle modes run **without `DATABASE_URL`**.
- **Round events** are NDJSON on `CRAWL_EVENTS_FD`: `claim`, `page`, `submit`, `ingest_ok`, `ingest_error`, `finalize_started`, `round_done`. They carry IDs and enums only. Events come only from the work loop, never from a timer.
- **Lock:** the same lockdir as bash's `hc_acquire_lock`, so a Go holder and a bash holder exclude each other. A child of the holder may pass.
- **SIGTERM:** finish the current suburb (including its push), then exit 10.

**Exit codes:**

| rc | Meaning | Runtime action |
|---|---|---|
| 0 | ok | next slot |
| 3 / 5 | re-warm budget spent / Kasada stub | one retry after 2 h; alarm after 3 cycles with no successes |
| 4 | Chrome unusable | one retry after 30 min, then circuit and alarm |
| 7 | agent infrastructure failed (including a BrandBrain mint outage) | retry at 5, 15 and 45 min, then alarm |
| 8 | environment broken | the cycle runs install-driver once and retries once; the runtime does not retry; alarm `env_broken` |
| 10 | cancelled | no retry |
| 11 | hung | one retry after 30 min, then circuit |
| 12 | skipped: lock held | no retry; 3 consecutive gives `legacy_conflict` |
| 13 | ingest auth refused | no retry; alarm `ingest_auth`; job deferred |
| 14 | ingest unavailable | retry after 30 min, then 2 h; jobs deferred; alarm after 6 h |
| 15 | ingest contract (collector too old or schema mismatch) | no retry; alarm `drift`; fix with a release and `upgrade_agent` |

Never retried automatically: 8 (after its one repair), 10, 12, 13 and 15, plus WAF 403s. Portal blocks inside a drain are handled only by the circuit breaker's deferral. **Circuit:** 3 consecutive failures pause that job until `housing_crawl_run` or `housing_crawl_repair` is sent.

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
- The collector calls the loopback `/control/v1/workload-token?audience=…` when less than 60 seconds remain, and once more on a 401.
- The loopback endpoint issues only allowlisted audiences and never logs the token.

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
