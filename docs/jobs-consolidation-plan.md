# Jobs consolidation: single `shorted` binary + paprika pilot

**Decision record (2026-07-25, approved by Ben):** consolidate every batch
job/crawler/collector into one Go binary in a fresh `services/jobs` module,
invoked as `shorted <job> [flags]`; port ALL Python jobs to Go (langextract has
a Go equivalent at `github.com/skunkworq/stealth/brws/langextract`); pilot 2–3
low-risk jobs as CronJobs on the paprika/omega VKE cluster.

## Why

17 job services today (12 Go, 5 Python) with heavy duplication:
`pgxpool` connect hand-rolled ×12, revalidate ping ×3, cost-metrics ×3,
env-config inline everywhere, `-mode`/`RUN_MODE` dispatch reinvented per
service, 8+ copy-pasted Cloud Run Job + scheduler Terraform modules, three
browser-automation drivers, 4 report tools with NO infra (laptop-only),
3 committed `venv/` dirs + 2 committed GCP SA key JSONs.

## Target shape

```
services/jobs/                  # fresh Go module: github.com/castlemilk/shorted.com.au/services/jobs
  cmd/shorted/main.go           # cobra-style root; `shorted <job> [flags]`
  internal/runner/              # shared job runner: flag/env config, otel, jobstatus, dry-run, logging
  internal/platform/            # db (pgxpool), gcs, revalidate, config — extracted from the ×12/×3 copies
  internal/jobs/<name>/         # one package per job, migrated from services/<name>
  Dockerfile                    # standard image
  Dockerfile.crawl              # chromium-less variant (host-CDP jobs; unchanged contract)
  deploy/paprika/               # Helm chart: CronJobs consuming the same image+args (Phase 4)
```

- One shared `terraform/modules/shorted-job/` (Cloud Run Job + scheduler + SA)
  instantiated per schedule with `args = ["<subcommand>", ...]` — replaces the
  copy-pasted modules one migration at a time.
- Jobs that talk to host Chrome via CDP (house-price crawl tier) keep running
  on the residential Macs — same binary, same subcommand, no container Chrome.
- Long-running APIs (shorts, market-data, chat-service) are OUT of scope.

## Migration order (one PR per step; old service deleted only after its
replacement has run green in prod ≥1 scheduled cycle)

**Phase 1 — scaffold + zero-risk ports (nothing deployed changes):**
1. Module scaffold: cmd/shorted, runner, platform (db/config/revalidate/otel
   glue), go.work entry, Dockerfile, CI build.
2. Port the laptop-only tools first (no prod risk, instant infra win):
   `influence` (influence-collector), `reports coverage|link|sync`
   (report-coverage/linker/sync trio — near-identical flags, shared
   source-classification code deduped).

**Phase 2 — deployed Go jobs, easiest→hardest:**
3. `announcements` (asx-announcement-crawler — fresh from PR #350, small)
4. `economy` (economy-collector — clean -mode structure already)
5. `weekly-report`, `news` (RUN_MODE → subflags), `signals` (port the 221-LoC
   Python collect.py to Go here — it's just brandbrain HTTP calls)
6. `market-data` (market-data-sync — service+CLI hybrid; keep the HTTP surface
   as `shorted market-data serve`, scheduler hits the same endpoint)
7. `discovery` (asx-discovery — playwright+Chromium; standard image grows a
   browser layer OR keeps its own image variant)
8. `house-prices` (house-price-collector — biggest, many modes; migrate last
   of the Go set; crawl modes keep Dockerfile.crawl / host-run contract)

**Phase 3 — Python→Go ports (each replaces a deployed job; port + parity-run
before cutover):**
9. `short-data-sync` (ASIC CSV → shorts table + MV refresh + revalidate) —
   the load-bearing one; port with a shadow-run comparing row counts vs the
   Python job before switching the scheduler. Kills the deprecated daily-sync
   image dependency noted in its TF module.
10. `report-extract` + `director-trades` — Gemini extraction via
    `stealth/brws/langextract` (Go port exists with golden-contract tests).
11. `stock-prices` (stock-price-ingestion FastAPI → `shorted stock-prices
    sync|backfill` + a thin serve mode if the POST /sync contract must stay).
12. Delete `services/daily-sync` (already deprecated), purge committed venvs
    and the two `shorted-dev-*.json` SA keys (rotate them first).
13. `enrichment` (enrichment-processor — Pub/Sub push service + batch mode;
    port batch mode into the binary, decide the service surface separately).

**Phase 4 — paprika pilot (after Phase 2 lands the image):**
- Fix `greenveil_core` tfstate drift in paprika/terraform FIRST (state has a
  pool main.tf doesn't — apply would destroy it).
- Add a small tainted node pool (`dedicated=shorted:NoSchedule`, copy the
  greenveil-search block).
- Tenant: namespace + AppProject + one `Application` CR (git source → this
  repo's `services/jobs/deploy/paprika` chart) + imagePullSecret (platform
  provides none; registry = GCP Artifact Registry or ghcr).
- Pilot jobs: `signals`, `economy`, `influence` (pure HTTP pollers, DB+API
  secrets only). GCS/PubSub/WIF-coupled jobs stay on Cloud Run.
- Honest economics: Cloud Run Jobs at these schedules ≈ single-digit $/mo;
  a dedicated pool is fixed ~$20+/mo — the pilot is for dogfooding paprika
  and portability, not immediate savings.

## Invariants

- Every migration PR: same flags/env contract documented, same schedule, TF
  module swap in the SAME PR, old job paused (not deleted) until one green
  scheduled run of the replacement, then a cleanup PR deletes the old service.
- The `replace github.com/skunkworq/stealth => ../../stealth` go.work pattern
  + `FROM scratch AS stealth` Docker stage carries over to the new module.
- `pkg/` libs that both old and new code need during the transition stay in
  the `services` module; `services/jobs` imports them via a go.work replace
  until the last consumer migrates.

## Known divergence risks

- **`feat/politician-register-of-interests` vs `internal/jobs/influence`.** That
  branch adds register modes and `aph_*.go` files to
  `services/influence-collector` — the very service Phase 1 ports into
  `services/jobs/internal/jobs/influence`. The old service is **NOT frozen yet**,
  so the two branches will diverge. Whichever merges SECOND must port the delta
  across (new `-mode` cases, the `aph_*.go` collectors and their fixtures) into
  `internal/jobs/influence` — and, in the ported copy, convert any `log.Fatal*`
  call sites to returned errors: the consolidated binary has no
  panic/`log.Fatal` control flow, every `run*` mode helper returns `error` and
  `Run` chains them with early returns.
- Freeze the source services (README banner + a PR-template note) as soon as
  their port lands, so this only has to be paid once per job family.

## Cutover checklist — announcements + economy (from Phase 2 review)

- `.github/workflows/economy-freshness.yml` passes `--args="-mode,freshness"` —
  after repointing the Cloud Run job at the `shorted` image the args MUST become
  `economy,-mode,freshness` (a bare `-mode` exits 2 with usage).
- Log-based alerting: single-mode economy failures no longer emit an
  `ERROR <name>: <err>` textPayload line — the error surfaces as the runner's
  `[job] done ... status=error` line + main's `error:` exit line. Review any
  log-match alerts before cutover. (`-mode all` per-step ERROR lines unchanged.)
- OTel service name stays "asx-announcement-crawler" for dashboard continuity.
