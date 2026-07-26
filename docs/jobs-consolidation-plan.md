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

## Cutover slice 1 — announcements + economy (IN PROGRESS, branch `feat/jobs-monolith-cutover-1`)

Terraform/CI now run both jobs from the ONE consolidated image:

- CI builds `shorted-jobs` (`services/jobs/Dockerfile`, context `services`) in
  the `build-docker-images` matrix, and threads `-var="shorted_jobs_image=…"`
  into both `terraform plan` and `terraform apply` (mirrors the
  `house_price_collector_image` wiring from PR #211).
- `terraform/modules/shorted-job/` is the generic Cloud Run Job + Scheduler +
  invoker-SA module (`name`, `args`, `env`, `secret_env`, `schedule`, `paused`,
  `timeout_seconds`, `cpu`, `memory`, `max_retries`). Resource shapes copied
  from `modules/economy-collector`.
- Instantiated in dev + prod as `module.shorted_job_announcements`
  (job `shorted-announcements`, `["announcements", -director-trades,
  -dividends, -news-table, -all-announcements, -years 2024,2025,2026,
  -workers 6]`, `0 11 * * *`, 5400s, 2 CPU / 1Gi) and
  `module.shorted_job_economy` (job `shorted-economy`,
  `["economy", "-mode", "all"]`, `0 17 5 * *`, 1800s, 1 CPU / 512Mi).
- `.github/workflows/economy-freshness.yml` now executes `shorted-economy`
  with `--args="economy,-mode,freshness"` and greps logs for
  `job_name="shorted-economy"`.

**Old jobs are PAUSED, not deleted** (plan invariant): `scheduler_paused`
(default `false`) was added to `modules/asx-announcement-crawler` and
`modules/economy-collector` and set to `true` at both env call sites. The
Cloud Run Jobs themselves stay deployed and manually executable.

**Rollback (one variable per job, no destroy):**

1. Set `scheduler_paused = false` on the old module call site
   (`module.asx_announcement_crawler` / `module.economy_collector`) in
   `terraform/environments/{dev,prod}/main.tf`.
2. Set `paused = true` on the matching new module call site
   (`module.shorted_job_announcements` / `module.shorted_job_economy`).
3. `terraform apply`. Both schedules flip within one apply; nothing is
   destroyed and no image rebuild is needed.
4. For economy also revert `.github/workflows/economy-freshness.yml` to job
   `economy-collector` + `--args="-mode,freshness"` (the legacy image's
   entrypoint takes no subcommand).

**Cleanup (only after ≥1 green scheduled run of each replacement):** a follow-up
PR deletes `modules/asx-announcement-crawler`, `modules/economy-collector`,
their env call sites, the `asx_announcement_crawler_image` /
`economy_collector_image` vars, the two CI matrix entries and the source
services.

## Cutover checklist — announcements + economy (from Phase 2 review)

- `.github/workflows/economy-freshness.yml` passes `--args="-mode,freshness"` —
  after repointing the Cloud Run job at the `shorted` image the args MUST become
  `economy,-mode,freshness` (a bare `-mode` exits 2 with usage).
- Log-based alerting: single-mode economy failures no longer emit an
  `ERROR <name>: <err>` textPayload line — the error surfaces as the runner's
  `[job] done ... status=error` line + main's `error:` exit line. Review any
  log-match alerts before cutover. (`-mode all` per-step ERROR lines unchanged.)
- OTel service name stays "asx-announcement-crawler" for dashboard continuity.

## Cutover slice 2 — weekly-report + news + signals (branch `feat/jobs-monolith-cutover-2`)

Three more jobs now run from the ONE `shorted-jobs` image. No new CI wiring was
needed (`shorted_jobs_image` is already threaded into both envs by slice 1).

### `modules/shorted-job` gained multi-schedule support

The news topology is ONE Cloud Run Job with FIVE schedulers, four of which set
`RUN_MODE` (+ extra env) through `overrides.container_overrides` in the
scheduler HTTP body. Rather than five jobs, the shared module grew an optional
`schedules` list:

```hcl
schedules = [{
  name_suffix      = "cluster"          # → scheduler "<name>-cluster"
  cron             = "30 */2 * * *"
  description      = optional
  paused           = optional(bool)      # defaults to var.paused
  attempt_deadline = optional(string)    # defaults to var.scheduler_attempt_deadline
  args_override    = optional(list(string))
  env_override     = optional(map(string))
}]
```

- Encoded as `base64encode(jsonencode({overrides = {container_overrides = [{args=…, env=[{name,value}…]}]}}))`
  — byte-identical mechanism to the old news-aggregator / weekly-report
  schedulers. Entries with no override post NO body (a plain `:run`).
- `env_override` MERGES into the container env; `args_override` REPLACES the
  container args wholesale (so it must repeat the `shorted <subcommand>` prefix).
- `roles/run.developer` (needed for `runWithOverrides`; `run.invoker` alone
  403s) is granted only when at least one entry carries an override —
  `count = 0` otherwise.
- **The pre-existing single-schedule path is untouched.** `var.schedule` still
  drives the un-counted `google_cloud_scheduler_job.schedule`; the new triggers
  live in a separate `for_each` resource (`…extra_schedule`). No resource was
  re-addressed, so `module.shorted_job_announcements` /
  `module.shorted_job_economy` keep exactly the resources and attributes they
  have in state (empty `schedules` ⇒ `for_each = {}` ⇒ nothing planned).

### Instantiations (dev + prod)

| Module | Job | Args | Schedules | Resources |
|---|---|---|---|---|
| `shorted_job_weekly_report` | `shorted-weekly-report` | `["weekly-report"]` | `0 11 * * 5` (primary) + `monthly` `0 1 1 * *` w/ `REPORT_TYPE=monthly` | 900s, 1 CPU / 512Mi |
| `shorted_job_news` | `shorted-news` | `["news"]` | `0 */4 * * *` (primary) + `backfill-images` / `resolve-googlenews` / `cluster` / `digest`, each w/ `RUN_MODE=…` | 900s, 1 CPU / 512Mi |
| `shorted_job_signals` | `shorted-signals` | `["signals","--priority","top-shorted","--limit","200","--max-age-days","30","--workers","2"]` | `0 13 * * 1` | 3600s, 1 CPU / 512Mi |

Env/secret parity is one-for-one with the old modules, including the prod-only
splits: news reads `GEMINI_API_KEY` from the **`GEMINI_API_KEY_NEWS`** secret and
gets `EMAIL_IMG_SECRET` in prod only (dev's old module defaulted
`email_img_secret_exists = false`); weekly-report keeps `OPENAI_API_KEY` +
`GEMINI_API_KEY`; signals keeps `BRANDBRAIN_URL`. The dev instantiations gate
`GEMINI_API_KEY` on the same `var.gemini_secret_exists` the old modules used.

**Old jobs are PAUSED, not deleted:** `scheduler_paused` (default `false`) was
added to `modules/weekly-report-generator` (2 schedulers),
`modules/news-aggregator` (**all FIVE schedulers**) and
`modules/signals-collector` (1), and set to `true` at both env call sites.

**Rollback (variable flips only, nothing destroyed):** set
`scheduler_paused = false` on the old module call site and `paused = true` on the
matching `module.shorted_job_*`, then `terraform apply`. For `shorted_job_news`
and `shorted_job_weekly_report`, `paused = true` cascades to their extra
schedules too (each entry's `paused` defaults to `var.paused`).

**Cleanup (after ≥1 green scheduled run of each replacement):** delete
`modules/{weekly-report-generator,news-aggregator,signals-collector}`, their env
call sites, the `weekly_report_generator_image` / `news_aggregator_image` /
`signals_collector_image` vars, the CI matrix entries and the source services.

## Phase 2c ports — market-data + discovery (branch `feat/jobs-monolith-phase2c-ports`)

CODE ONLY: both jobs are ported into the `shorted` binary, nothing is deployed,
no Terraform/schedule changed, nothing deleted. `services/market-data-sync` and
`services/asx-discovery` stay in `services/go.work` and still build.

- `shorted market-data serve|sync|audit-gaps|historical-backfill`
  (was `services/market-data-sync` + `cmd/audit-gaps` + `cmd/historical-backfill`).
  `serve` preserves the full HTTP surface the weekday scheduler POSTs, so the
  cutover is a scheduler retarget, not a contract change.
- `shorted discovery` (was `services/asx-discovery`), env-only contract
  unchanged (`GCS_BUCKET_NAME`, `DOWNLOAD_DIR`).
- New `services/jobs/Dockerfile.browser`: SAME binary + build stage as
  `Dockerfile`, Debian + Chromium runtime. `discovery` is the only job that
  needs it; the standard distroless image stays lean for the other eight.
- **Landmine found:** `asx-discovery`'s scraper imports
  `github.com/mxschmitt/playwright-go` (resolved via `go.work` from the parent
  module, v0.6100.0 → driver 1.61.1) while its `go.mod` requires an unused
  `playwright-community/playwright-go v0.5200.1` (driver 1.52.0) and its
  Dockerfile pins npm `playwright@1.57.0`. The pre-bundled Chromium has never
  matched the driver, so every run re-downloads ~165 MiB from
  `cdn.playwright.dev`. `Dockerfile.browser` pins **1.61.1** to match the
  driver `jobs/go.mod` now requires directly.
- Full divergence tables, omitted scratch CLIs and dep-version convergences:
  `services/jobs/README.md` ("Phase 2c port notes").

## Phase 3 port — report-extract + director-trades (branch `feat/jobs-monolith-report-extractor`)

CODE ONLY: `services/report-extractor` (3 Python scripts) is ported into the
`shorted` binary; nothing is deployed, no Terraform/schedule changed, nothing
deleted. `terraform/modules/report-extractor` still points both Cloud Run Jobs
(`financial-report-extractor` weekly, `director-trade-extractor` daily) at the
Python image.

- `shorted report-extract concurrent` ← `extract_reports_concurrent.py` (deployed)
- `shorted report-extract sequential` ← `extract.py`'s main() (laptop CLI)
- `shorted director-trades` ← `extract_director_trades.py` (deployed)

`report-extract` is a GROUP because the two report scripts disagree on flag
defaults (`--recent` 2 vs 0, `--workers` 8 vs a `--delay` loop, `--mode all` vs
`top50`); one flat subcommand would have silently changed a caller's defaults.

**Blocking pre-cutover item — PDF text extraction changed engine.** pymupdf has
no pure-Go equivalent that can ship in the static image, so the port uses
`github.com/ledongthuc/pdf`. Page selection, the `"\n\n"` join and the 100-char
floor are unchanged, but the extracted TEXT differs (layout/whitespace/glyph
coverage), which moves `raw_text_length`, some `no_pdf`/`no_text` outcomes and,
downstream, metric+digest quality. A side-by-side run over a sample of real ASX
announcements is required before the schedulers are repointed. Full parity
tables + 8 loud callouts: `services/jobs/README.md` ("Phase 3 port notes").

## Cutover checklist — weekly-report + news + signals

- **news logs move stdout → stderr.** The standalone binary called
  `log.SetOutput(os.Stdout)`; the monolith logs to stderr like every other job.
  Any log-based metric/alert filtering on the stdout stream for
  `news-aggregator` must be repointed (stream + `job_name="shorted-news"`).
- **Job/resource names change**, so every log filter, dashboard and jobstatus
  query keyed on the Cloud Run job name needs updating:
  `weekly-report-generator` → `shorted-weekly-report`, `news-aggregator` →
  `shorted-news`, `signals-collector` → `shorted-signals`. Scheduler names
  likewise (`news-aggregator-periodic` → `shorted-news-schedule`,
  `-backfill-images`/`-resolve-googlenews`/`-cluster`/`-digest` keep their
  suffixes under the `shorted-news-` prefix; `weekly-report-generator-weekly` →
  `shorted-weekly-report-schedule`, `-monthly` → `shorted-weekly-report-monthly`;
  `signals-collector-weekly` → `shorted-signals-schedule`).
- **OTel service names are unchanged** (`weekly-report-generator`,
  `news-aggregator`, `signals-collector`) for dashboard continuity — the OTel and
  Cloud Run identities now differ deliberately.
- **Single-mode failures** surface as the runner's `[job] done … status=error`
  + main's `error:` line rather than the old per-binary `ERROR` textPayload —
  same caveat as slice 1, re-check log-match alerts.
- **Scheduler retry_config is normalised** by the shared module (retry_count 2 /
  max_retry_duration 3600s / backoff 10s–1800s). The old news + signals
  schedulers used `retry_count = 1` and, for the periodic/cluster/digest
  triggers, shorter max_retry/backoff windows. Attempt deadlines ARE preserved
  per schedule (600s/1800s).
- **`shorted news` with no `RUN_MODE` aggregates** (flag default), so the
  primary schedule needs no body — but an UNKNOWN `RUN_MODE` now fails fast
  instead of silently falling through to aggregate. Keep override values exactly
  as listed above.
- `PUBLIC_SITE_URL` + `EMAIL_IMG_SECRET` remain load-bearing for
  `RUN_MODE=digest` (signed `/api/email/img` thumbnails must verify against the
  Vercel-side secret).
- Revalidation env (`REVALIDATION_URL`/`_SECRET`) was NOT set on the old
  weekly-report module and is still not set — `platform.PingRevalidate` no-ops,
  same as today. Wiring it is a separate change.
