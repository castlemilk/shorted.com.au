# Operations

## Local

```bash
make dev-db                       # postgres on :5438
cd services && make migrate-up
make register-photos-dry          # from the repo root; starts the DB itself
```

DB: `postgresql://admin:password@localhost:5438/shorts`.
PDFs: `/Volumes/gamma-systems-2/shorted-crawl/aph-register` (never `/tmp` — it is
cleared on reboot, and re-crawling a government site is rude and slow).

Set `ELECTORATES_DIR=<repo>/web/public/geo/electorates` or the party seed skips.

The shorts API env prefix is **`APP_`** (not `SHORTS_`) — `APP_PORT` picks the
port. Its bot interceptor 403s curl without a browser UA.

**Confirm the LISTEN pid is the server you just started** before trusting any
result: `lsof -nP -iTCP:<port> -sTCP:LISTEN`. A stale squatter on 9091 serves old
code and produces a false pass.

## Prod

### The deploy does NOT run `migrate up`

`terraform-deploy.yml` applies a **hardcoded allowlist** of migration files on
prod (`000070/71/74/75/81/82/83/85`). Anything else must be applied **by hand,
before the merge** — or the API ships selecting columns prod lacks and every
politician read path 500s. That is what happened in the #364 release, caught only
by the release smoke.

Apply via the **session pooler (5432)**, not the transaction pooler (6543), with
`PGOPTIONS="-c statement_timeout=0"`. The URL is in `services/.env`.

**Prod `schema_migrations` lies.** It said 75 while objects from 81/86/90
existed, because prod DDL is applied by hand. `make migrate-up` against prod
would re-run 76–95. Apply only what you need, directly.

### Release order

1. Migrations by hand
2. **API before web** — a new RPC 404s on prod until the API ships. The web
   degrades gracefully (verified), but sections render empty
3. `make register-senators` (before the two below — it MINTS the identity they
   read; migration `000106` must already be applied, and the run must be dry-run
   previewed first because it creates people), then `make register-photos` /
   `make register-index`
4. **Revalidate**: a promote resets ISR pages to their build-time placeholder
5. Verify the *page*, not just the API

### Landmines that have actually bitten

**A green PR means less than it looks.** `run-tests` is
`if: github.event_name != 'pull_request'` — Go and integration tests run only on
push to `main`, gating the *deploy*, not the PR. **`golangci-lint` is in no CI job
at all**; it exists only in the local pre-push hook, and it times out loading
packages when the machine is swap-starved.

**`gh pr merge` fails locally with "'main' is already used by worktree"** — the
merge still lands on GitHub; only the local checkout fails.

**Cloudflare blocks curl and headless Chromium on the web zone.** The documented
`X-Shorted-Testing-Bypass` covers `api.shorted.com.au` only. Verify prod *pages*
via CI smoke or a real browser — a 403 there says nothing about the page.

**Algolia's `-dsn` read replica 404s for a few seconds after an index is first
created.** Re-query before concluding the build failed.

**`/api/revalidate` takes the secret as a query param `?secret=`**, not a header.

**Zeroed pages after a deploy.** If `/politicians` shows 0 across the stat tiles
while the API is healthy, it is the cache, not the data:

```
POST /api/revalidate?secret=…&path=/politicians&flush=politicians
```

The read-path fix means this now self-heals, but the flush is the immediate
unblock. See [data-model.md](data-model.md#caching).

## How prod was populated, and how to do it again

The durable assets are `register_documents` (804 rows) and `register_extractions`
(806 rows, ~5.5 MB). **Copying just those two tables and running load + resolve
reproduces everything** without re-hitting APH or re-paying for vision.

`pg_dump` 17 emits `SET transaction_timeout`, which Supabase rejects — filter it
with `grep -v '^SET transaction_timeout'`.

Caveat: `storage_uri` then points at the operator machine, so a prod **re-extract**
needs a `register-fetch` first to populate the GCS bucket.

## The freshness sentinel, and why it will not go green on its own

`.github/workflows/register-freshness.yml` runs `-mode register-freshness` as a
prod Cloud Run execution every Monday 21:47 UTC. Any ALARM exits non-zero, which
fails the workflow AND trips the generic "Cloud Run Job execution failed" alert
policy on `influence-collector` — so one alarm arrives twice, and the GCP copy
names neither the mode nor the check.

**The report only exists in the job's stdout.** `gcloud run jobs execute --wait`
prints `The execution failed.` and nothing else. The workflow now reads the
report back out of Cloud Logging (scoped to the execution it just created, since
the same job also runs the monthly `-mode all` ingest) into the step log, the
step summary and a `register-freshness` issue that closes on the next green run.
Before that, runs 5-7 (2026-09-01/07/15) went red with nobody able to see which
check had fired.

To read it by hand:

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="influence-collector"' \
  --project rosy-clover-477102-t5 --freshness 30m --limit 100 \
  --order asc --format="value(textPayload)"
```

**`aph-staleness` is structural, not a fault.** The threshold is 28 days
(`defaultRegisterStaleDays`), and the crawl modes that would reset it are
operator-run and deliberately never scheduled — `-mode all` excludes them, and
the influence-collector Terraform module says why. So roughly four weeks after
any crawl the sentinel goes red and STAYS red, alarming weekly, until someone
runs the chain by hand:

```
register-discover -> register-fetch -> [python extract] -> register-load -> register-resolve
```

with `REGISTER_DRY_RUN=false` (it defaults true in code and is pinned true on the
job). Budget ~20 minutes for the fetch alone; see pipeline.md for the order and
for `register-index` having to run last.

Decide it deliberately, because the two exits are a real choice: either recrawl
on a cadence shorter than 28 days, or raise the threshold to whatever cadence you
actually intend. Leaving a 28-day alarm over an unscheduled crawl trains everyone
to ignore a sentinel that also carries `aph-waf` — the one check that tells you
APH has revoked the posture the crawl depends on.

**`aph-waf` is never worked around.** A 403 means re-probe the no-User-Agent
posture by hand and, if it is genuinely revoked, stop crawling. Spoofing a
browser User-Agent is WAF evasion.

## Verifying

```bash
# the read paths that carry the photo columns — these 500 if a migration is missing
for m in GetParliamentOverview ListPoliticians GetPolitician ListStockPoliticians; do
  curl -s -o /dev/null -w "$m %{http_code}\n" -X POST \
    "https://api.shorted.com.au/shorts.v1alpha1.PoliticiansService/$m" \
    -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' \
    -H 'User-Agent: Mozilla/5.0' -d '{}'
done
```

`ListStockPoliticians` is the canary: it is embedded on `/shorts/[code]`, so it
takes a high-traffic page down rather than just the register hub.

## The method that keeps working

Two things in this subsystem's history are worth repeating rather than
rediscovering:

**A defect can pass every aggregate check.** The §8.15 fold change moved the gate
0.1pt, kept tests green and rendered chips — while publishing real ASX listings
under a "super fund" chip whose tooltip denied they were listed. It surfaced only
when a reviewer was told to **refute** the work and queried the database for
actual rows. Two prior diagnoses and one implementation report were also wrong.
**Assume the report, not just the code, needs independent checking.**

**Green tests are not a passing build, and a passing build is not a working
page.** Every jest test passed while `next build` failed on a client-boundary
import; the build passed while the page served zeros from cache. Check the layer
you are actually claiming works.
