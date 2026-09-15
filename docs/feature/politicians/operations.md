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

## The freshness sentinel

`.github/workflows/register-freshness.yml` runs `-mode register-freshness` as a
prod Cloud Run execution every Monday 21:47 UTC. Any ALARM exits non-zero, which
fails the workflow AND trips the generic "Cloud Run Job execution failed" alert
policy on `influence-collector` — so one alarm arrives twice, and the GCP copy
names neither the mode nor the check.

**The report only exists in the job's stdout.** `gcloud run jobs execute --wait`
prints `The execution failed.` and nothing else. The workflow reads the report
back out of Cloud Logging (scoped to the execution it just created, since the
same job also runs the monthly `-mode all` ingest) into the step log, the step
summary and a `register-freshness` issue that closes on the next green run.
Before that, runs 5–7 (2026-09-01/07/15) went red with nobody able to see which
check had fired — it was `aph-staleness`, newest fetch 2026-08-02.

To read it by hand:

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="influence-collector"' \
  --project rosy-clover-477102-t5 --freshness 30m --limit 100 \
  --order asc --format="value(textPayload)"
```

| Check | Fires when | What it means |
|---|---|---|
| `aph-waf` | any document currently on HTTP 403 | APH may have revoked the no-UA posture. **Never** work around it with a browser UA — re-probe by hand, and stop crawling if it is real |
| `aph-staleness` | the listing has not been read for 28 days (`last_listed_at`; rows older than 000123 fall back to `fetched_at`) | `register-discover` has stopped running |
| `aph-fetch-backlog` | documents still queued 7 days after the listing that queued them was read | discover runs, fetch does not |
| `aph-extract-backlog` | fetched text documents whose **current bytes** have no extraction for 14 days | the extractor is not draining (scans and superseded rows excluded) |
| `aph-unpaired-departures` | INFO only | a House row left its listing without a successor; load withholds a new document in that division until a person decides |

**Staleness does not clear on its own.** The crawl modes are operator-run and
deliberately never scheduled (`-mode all` excludes them; the influence-collector
Terraform module says why). Decide it deliberately: recrawl on a cadence shorter
than 28 days, or change the threshold to the cadence you intend. A 28-day alarm
over an unscheduled crawl trains everyone to ignore a sentinel that also carries
`aph-waf`.

## Re-crawling prod

The crawl is incremental (pipeline.md, "Re-crawling"), so a re-crawl fetches only
what changed. Order is not optional.

**0. DDL — carried by the deploy, not by hand.** Migration
`000123_register_document_succession` is in the terraform-deploy **allowlist**,
and that step runs BEFORE `terraform apply` swaps the jobs image, so the two
columns exist before any code that selects them. It is two
`ADD COLUMN IF NOT EXISTS`, one `CREATE INDEX IF NOT EXISTS` and a CHECK guarded
by a `pg_constraint` lookup — no row read or written — so the replay it gets on
every deploy is a no-op. (`scripts/tests/migration-drift.test.mjs` enforces both
halves: a migration must be allowlisted or recorded hand-applied in
`PROD_APPLIED.md`, and anything allowlisted must be replay-safe.)

Confirm it landed before crawling:

```bash
psql "$SESSION_URL" -c '\d register_documents' | grep -E 'last_listed_at|superseded_by'
```

If the columns are missing, the deploy has not run yet — wait for it rather than
racing it by hand.

**1. Discover.** Downloads nothing; ~10 seconds.

```bash
gcloud run jobs execute influence-collector --project rosy-clover-477102-t5 \
  --region australia-southeast2 --args="influence,-mode,register-discover" \
  --update-env-vars=REGISTER_DRY_RUN=false --wait
```

Read the log before going on. On 2026-09-15 the expected shape was: parliament 48
→ 151, 47/46/45/44 → 155/153/158/152, Senate 36; `147 house documents left their
listing: 147 linked to a successor, 0 unpaired`. **Any unpaired departure is a
stop:** find it (`aph-unpaired-departures` names one) and decide before loading.

**2. Fetch.** Same command, `-mode,register-fetch`. ~150 documents at 1.5s ≈ 4 min.
A single 403 aborts the run by design.

**3. Extract — operator machine, SCOPED.** Senate volumes OCR through Apple Vision and
the vision tier shells out to `agy`, neither of which exists in a container. The
House API statements are born-digital and read deterministically (three sampled
on 2026-09-15: 100% coverage). Needs ADC for the `gs://` objects:

```bash
cd services/report-extractor
DATABASE_URL="$PROD_TXN_URL" python extract_register.py --stage classify
DATABASE_URL="$PROD_TXN_URL" python extract_register.py --stage extract
# scan/mixed documents only, and SCOPE IT — see the volume note below:
DATABASE_URL="$PROD_TXN_URL" python extract_register.py --stage vision --chamber house --parliament 48
```

**When `agy` goes quiet, switch backends rather than waiting.** Measured
2026-09-15: `agy` read one document to 76% and then returned EMPTY STDOUT for
every page of both documents across three runs and ~70 minutes — no error, no
quota exception, just nothing. The same two documents through
`--vision-backend gemini-api` (key in `services/.env`) came back at **100%
coverage in 17 seconds**: 14 items / 54 declared rows and 12 items. A silent
backend is now counted as unavailable and leaves the status columns alone, so
retrying costs nothing but time — but do not spend an hour on it:

```bash
GEMINI_API_KEY=… python extract_register.py --stage vision \
  --chamber house --parliament 48 --vision-backend gemini-api --force
```

`--force` is required to re-read a document that already has a vision artifact
(a `partial` one still counts), and is safe here because the artifact is keyed by
`(sha, extractor_version, tier)` — the better read supersedes the worse.

**Most of prod's corpus is not reachable from a container, or from a laptop
without the crawl volume.** 598 documents carry a `file://` storage_uri pointing
at `/Volumes/gamma-systems-2/shorted-crawl/aph-register` — the original crawl ran
with a local sink, and only documents fetched since (the GCS sink) can be read
anywhere else. So an UNSCOPED stage reaches documents whose bytes are not there.

That is survivable now and was not before 2026-09-15: an unscoped `--stage
extract` marked 84 unreachable vision-tier documents `failed`, which is one
`register-load` away from purging 84 members' published declarations
(`purgeNonExtractedStatements` deletes the rows of anything not `extracted`).
`open_document` now raises `DocumentUnavailable` for bytes it cannot READ and
every stage leaves the status columns alone for those, counting them separately
("N document(s) could not be READ and were left untouched"). Pinned by
`test_register_availability.py`.

Credentials, while you are here: the extractor reads `gs://` through ADC. If
`gcloud auth application-default` belongs to another account you get a 403 per
document — which is now reported as unavailable rather than written to the
manifest, but still extracts nothing.

**4. Load, then resolve** (`-mode,register-load`, then `-mode,register-resolve`).
Load should report `succession: 147 documents took their identity from a
superseded predecessor, 147 predecessors retired` and **0 withheld**; resolve
rebuilds the fold and the public MV.

**5. Index, revalidate, verify.** `make register-index` (Algolia, last), then the
`/politicians` revalidate below, then the canary curl under Verifying. Finish with
`-mode,register-freshness`: it should be green.

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
