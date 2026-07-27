# Incident: shorts API hard-down ~3.5h — `INTERNAL_SERVICE_SECRET` version disabled

**Date:** 2026-07-26 (UTC)
**Duration:** ~3h20m (first 500s ~21:00 UTC → restored 00:10 UTC on 07-27)
**Impact:** `api.shorted.com.au` (shorts Cloud Run service) hard-down. All
Connect-RPC reads failed; the web app served errors/placeholders on every
API-backed surface once cached/ISR content expired.
**Severity:** SEV-1 (total API outage, self-inflicted, automated)

## Timeline (UTC)

| Time | Event |
|------|-------|
| 20:00 | Cost Guardian daily cron fires (`.github/workflows/cost-guardian.yml`, `0 20 * * *`). |
| ~20:50 | The `cleanup-secret-versions` job disables versions **1000, 1001 and 1002** of `INTERNAL_SERVICE_SECRET` in prod (`rosy-clover-477102-t5`). 1002 is what the `latest` alias resolves to. |
| ~20:50–21:00 | No immediate impact: already-running Cloud Run instances had read the secret at startup and hold it in memory. |
| ~21:00 | First 500s. As warm instances recycle (scale-to-zero / autoscaling churn), **new** instances fail to start: the container mounts `INTERNAL_SERVICE_SECRET:latest`, which now resolves to a DISABLED version → `FAILED_PRECONDITION` → startup probe failure. |
| ~21:00–00:00 | Sustained outage. Every request routes to an instance that cannot start; nothing in the deploy pipeline changed, so the cause is not visible in Vercel/Terraform history. |
| 00:10 | Mitigated by re-enabling version **1002** (`gcloud secrets versions enable 1002 --secret=INTERNAL_SERVICE_SECRET`). New instances start; API recovers. |

## Root cause #1 — lexicographic sort in the cleanup job

`cleanup-secret-versions` kept "the newest KEEP_COUNT" versions using:

```bash
gcloud secrets versions list "$secret" --filter="state=enabled" --sort-by="~name"
```

`--sort-by="~name"` sorts version names as **strings**. Below 1000 versions this
looks correct. Past 1000 it inverts:

```
lexicographic desc: 999, 998, 997, ..., 1002, 1001, 1000
numeric desc:       1002, 1001, 1000, 999, 998, ...
```

So the job "kept" 999 and 998 and disabled everything after them in the
lexicographic list — which included 1000, 1001 and **1002, the version `latest`
points at**. Cloud Run's `latest` does not fall back to an older enabled
version; it fails the mount, and the container never starts.

Compounding factors in the same step:

- Nothing protected the numerically-highest version unconditionally.
- Nothing checked whether a version was actually **in use** by a Cloud Run
  service or job before disabling it.
- The `TOTAL_DISABLED` counter incremented inside a `... | while` pipeline
  (a subshell), so the summary always reported 0 — the run looked like a no-op.

## Root cause #2 — the churn that produced 1,002 versions

`terraform-deploy.yml` had three near-identical `ensure_secret()` copies whose
"has the value changed?" test was:

```bash
CURRENT=$(gcloud secrets versions access latest --secret="$name" ...)
if [ "$CURRENT" = "$value" ]; then skip; else add-version; fi
```

Command substitution `$(...)` **strips all trailing newlines** from what it
captures. The GitHub Actions secret value (`$value`) keeps its trailing newline;
`$CURRENT` structurally cannot. So for any GH secret pasted with a trailing
newline the comparison could never be equal, and **every deploy added a new
version, forever**. `INTERNAL_SERVICE_SECRET` reached 1,002 versions this way —
which is the only reason the sort bug was ever reachable.

(Secondary: on a failed `versions access latest` the code fell through to
`add-version`, so a disabled-latest state would have been papered over with yet
more versions.)

## Fixes

**1. `scripts/secret-version-cleanup.sh`** (new) — the version-selection logic is
out of YAML and unit-tested (`scripts/secret-version-cleanup.test.mjs`,
`node --test`). Four structural guards:

- **Numeric ordering** (`sort -rn`), never lexicographic. Tested explicitly
  across the 999 → 1000 boundary with the incident's exact version set.
- **The numerically-highest version is never touched**, regardless of state or
  KEEP_COUNT — that is what `latest` resolves to.
- **In-use protection**: before touching anything in a project, every
  `(secret, version)` pair referenced by Cloud Run **services and jobs** is
  enumerated (`run services/jobs list` + `describe` per resource, handling both
  the knative v1 and v2 payload shapes) and cached once per project run. A
  pinned numeric version is excluded for that secret. **Any enumeration failure
  is fatal** (`exit 1`) and a zero-reference result aborts the run — we never
  proceed to disable with a silently-empty in-use list.
- **KEEP_COUNT=2** newest *enabled* versions are kept on top of the above.

**2. Billing truth + an opt-in destroy pass.** A DISABLED version still bills in
Secret Manager (~$0.06/version/month); only DESTROYED versions stop. So the
disable pass saves nothing — it is hygiene. A conservative destroy pass exists
behind the **default-false** workflow input `destroy_old_secret_versions`, and
only destroys versions that are (a) not the numeric latest, (b) not in use,
(c) already disabled, and (d) older than 90 days, capped at 200 per secret per
run, with `--dry-run` honoured. **Judgement call:** destroy is irreversible, so
it is opt-in rather than on the daily cron. Run it manually (dry-run first) when
the version bloat needs to actually leave the invoice.

**3. `scripts/ensure-secret.sh`** (new) — one implementation replacing all three
inline `ensure_secret()` copies in `terraform-deploy.yml`:

- Compares `sha256` of the bytes, not shell string equality.
- **Strips trailing CR/LF from both sides before hashing**, and always writes
  with `printf %s` (no trailing newline), so the read path (which strips) and
  the stored value converge instead of churning forever.
- If `versions access latest` fails on a secret that **exists**, it logs a loud
  `::warning` and **skips** — it never adds a version on an access failure.

`release-preview-smoke.yml`'s `add_env_pair()` was checked and is unrelated: it
builds `vercel deploy --env` pairs and never touches Secret Manager.

## Detection & follow-ups

- The outage was found by hand. Nothing alerted on "Cloud Run revision failing
  startup probe" — worth a follow-up alert policy, since a config-only failure
  leaves no trace in the deploy pipeline.
- Consider pinning `INTERNAL_SERVICE_SECRET` to a **specific version number** in
  Terraform rather than `latest`, so cleanup automation and the runtime agree on
  exactly one protected version.
- The old prod version backlog (~1,000 disabled versions) is still billing until
  a destroy pass runs.

## One-line lesson

Automated cleanup must prove a thing is unused before removing it — and
"newest" is a **numeric** property, not a string one.
