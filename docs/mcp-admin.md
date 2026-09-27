# Admin MCP server — `/mcp/admin`

A second MCP server for **administrators**, served by the shorts API at
`https://api.shorted.com.au/mcp/admin`. It does two things: publish a merged
`content/news` article to `/news` (the `shorted-news-publish` Cloud Run job), and
run the stock picker's data job on demand (the `shorted-picks` Cloud Run job, in
any of its four modes).

## Connect it (once)

claude.ai → Settings → Connectors → **Add custom connector** →
`https://api.shorted.com.au/mcp/admin`. Claude discovers the OAuth server,
sends you to the Shorted consent screen, you sign in with your normal account
and approve **news:publish** and **jobs:run**. The connector then appears in
every Claude session (including Claude Code on the web) with four tools:

| Tool | Scope | What it does |
|---|---|---|
| `publish_news_article` `{slug, images?, force?}` | `news:publish` | Starts the publish job for a merged article; returns `execution_name` |
| `news_publish_status` `{execution_name}` | `news:publish` | `running` / `succeeded` / `failed`, log link, failure reason |
| `run_picks_job` `{mode, force?}` | `jobs:run` | Starts `shorted picks -mode <mode>` (`fundamentals` \| `filings` \| `refresh` \| `all`); returns `execution_name`, the argv and the next step of the coverage runbook |
| `picks_job_status` `{execution_name}` | `jobs:run` | `running` / `succeeded` / `failed`, log link, failure reason (exit 10 in the message = DEGRADED, a partial pull) |

Only merged articles can be published — the job image bakes `content/news` in
at build time, and the tool takes a slug, never a body. Likewise the picks tool
takes a **mode**, never arguments: the server builds `picks -mode <mode>` from
a closed enum, and the only job it can aim at is `shorted-picks`.

**Building first fundamentals coverage** (the reason `run_picks_job` exists):
`fundamentals` covers up to 400 stale codes a run (~30 minutes) against a
~2,300-code universe, so ask for it repeatedly until the public server's
`get_strategy_picks` reports `fundamentals_coverage_count` near the universe,
then `filings`, then `refresh`. The tool's `next` field says this after each
run. The nightly 15:00 UTC schedule runs `all` from then on. A second run is
refused while one is in flight (`force` overrides, for a stuck execution).

**Connected before `jobs:run` existed?** Your token carries only
`news:publish`. The publish tools keep working; the picks tools answer with a
tool error naming the missing scope. Disconnect and reconnect the connector to
approve it (an empty scope request is granted the whole admin vocabulary).

**This connector exposes ONLY those four admin tools; it is not a superset of
the public server.** A research client — one that needs short positions,
strategy picks, fundamentals, housing, economy or the register of interests —
must also connect the public URL, `https://api.shorted.com.au/mcp`, as its own
connector.

## Who can use it

An administrator is a Shorted account whose **verified** email is on the web
app's `ADMIN_EMAILS` allowlist (the same list that gates `/admin`). It is
checked:

1. by the consent screen (clear message for non-admins),
2. when the API mints the consent ticket,
3. at the code grant,
4. at the code → token exchange,
5. on **every refresh** (so a removed admin cannot keep rotating a 30-day family),
6. on **every MCP request** (`RequireAdmin`, cached ~5 min per user).

The API asks the web app (`POST /api/internal/admin-check`, behind
`INTERNAL_SERVICE_SECRET`) because OAuth tokens carry only a user id and
turning a uid into an email needs Firebase Admin `getUser` — a project-level
IAM grant the CI deploy account cannot make. `ADMIN_CHECK_URL` overrides the
default (`https://shorted-com-au-document-analyser.vercel.app/api/internal/admin-check`,
the Vercel origin, because Cloudflare challenges non-browser POSTs to the apex).

## How it is kept apart from the public server

- **Separate OAuth resource.** Tokens are audience-bound to exactly one
  resource: a `/mcp` token is refused on `/mcp/admin` and vice versa.
- **Separate scope vocabulary.** `news:publish` and `jobs:run` are not in
  `mcp.Scopes`; an empty scope request on `/mcp` still gets only the `:read`
  scopes, and an absent `resource` still defaults to `/mcp` — nothing ever
  defaults to the admin resource (`oauth/resources.go`). Admin scopes name
  ACTIONS, one per tool family; each tool checks its own (`requireScope`), and
  the HTTP layer requires at least one admin scope rather than all of them, so
  adding a scope never logs an existing connector out.
- **No anonymous path.** `/mcp/admin` requires a token (401 + RFC 9728
  challenge naming `/.well-known/oauth-protected-resource/mcp/admin`), and 403s
  a token carrying no admin scope.
- **Override runs are two-halved.** Every write tool runs a Cloud Run Job with
  argument overrides, which needs `roles/run.developer` — granted per job, to
  exactly the jobs with a server-side argv builder (`shorts-data-sync`,
  `shorted-news-publish`, `shorted-picks`; `scripts/tests/picks-job.test.mjs`
  counts them). The argv is never caller text: a slug matched against a pattern,
  a mode matched against an enum.
- **Separate registry.** The admin tools are not in `mcp.Registry()`, so the
  public catalog, read-only annotations and payload budgets are untouched.

Files: `services/shorts/internal/mcp/admin.go`, `internal/jobmonitor/publish.go`,
`internal/jobmonitor/picks.go`, `internal/oauth/resources.go`,
`internal/services/shorts/admin_check.go`, `web/src/app/api/internal/admin-check/`.

## Failure modes

- **"forbidden: administrator access required"** on every call — the admin
  check is failing (web endpoint unreachable, `INTERNAL_SERVICE_SECRET`
  mismatch between Vercel and Cloud Run, or the email is unverified / not on
  `ADMIN_EMAILS`). Look for `admin check:` in the shorts API logs.
- **`invalid_target`** from the consent screen — the API was deployed without
  `INTERNAL_SERVICE_SECRET`, so no admin checker exists and the admin resource
  is not grantable (fail closed).
- **"this connection was not granted the jobs:run scope"** as a tool error —
  the connector was authorised before the scope existed; reconnect it.
- **"job execution is not configured in this deployment"** from `run_picks_job`
  — the API's service account lacks `run.developer` on `shorted-picks`
  (Terraform `shorts_api_picks_overrides` not applied) or the job monitor has no
  project; a 403 from Cloud Run surfaces the same way. `gcloud run jobs
  get-iam-policy shorted-picks --region australia-southeast2` should list the
  shorts API SA with `roles/run.developer`.
