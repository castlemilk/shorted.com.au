# Admin MCP server — `/mcp/admin`

A separate MCP server for **administrators**, served at
`https://api.shorted.com.au/mcp/admin`. It observes asynchronous jobs and queues,
publishes merged news articles, and starts the stock-picks data job.

The public, anonymous-first research server is a separate connection:
`https://api.shorted.com.au/mcp`. Public and admin tokens have different audiences;
connecting either server does not grant access to the other.

## Connect it (once)

For Codex, install the private **Shorted Admin** plugin packaged in
`plugins/shorted-admin`, connect its OAuth server with your verified Shorted
administrator account, and open **Shorted Admin** from the Apps navigation.
The plugin's global and thread entrypoint calls `list_async_jobs` with `{}`.
Its package contains only the endpoint, branding and operational instructions;
credentials remain in the host connection.


claude.ai → Settings → Connectors → **Add custom connector** →
`https://api.shorted.com.au/mcp/admin`. Claude discovers the OAuth server,
sends you to the Shorted consent screen, you sign in with your normal account
and approve **jobs:read**, **news:publish** and **jobs:run**.
For a monitoring-only client, request only `jobs:read`. The connector then appears in
every Claude session (including Claude Code on the web) with nine tools:

| Tool | Scope | What it does |
|---|---|---|
| `list_async_jobs` `{query?, status?}` | `jobs:read` | Fleet overview, concurrent running executions, schedule triggers, health, task counts, errors, log links and source coverage. Also opens the sidebar/chat view. `status: "running"` includes older or unhealthy active executions. |
| `list_job_executions` `{job, region?, limit?, page_token?}` | `jobs:read` | Paginated history; follow `nextPageToken` until absent. Default 20, maximum 100. |
| `get_job_execution` `{job, region?, execution_name}` | `jobs:read` | Fresh status of one execution, including task/retry/cancellation counts, timings and log link. |
| `list_enrichment_jobs` `{status?, limit?, offset?}` | `jobs:read` | Database queue with queued/processing/completed/failed/cancelled filters, stock, timestamps and error; follow `nextOffset`. |
| `search_job_mentions` `{query}` | `jobs:read` | Composer job search; returns up to 20 scope-protected resource references. |
| `publish_news_article` `{slug, images?, force?}` | `news:publish` | Starts the publish job for a merged article; returns `execution_name` |
| `news_publish_status` `{execution_name}` | `news:publish` | `running` / `succeeded` / `failed`, log link, failure reason |
| `run_picks_job` `{mode, force?}` | `jobs:run` | Starts `shorted picks -mode <mode>` (`fundamentals` \| `filings` \| `refresh` \| `all`); returns `execution_name`, the argv and the next step of the coverage runbook |
| `picks_job_status` `{execution_name}` | `jobs:run` | `running` / `succeeded` / `failed`, log link, failure reason (exit 10 in the message = DEGRADED, a partial pull) |

Only merged articles can be published — the job image bakes `content/news` in
at build time, and the tool takes a slug, never a body. Likewise the picks tool
takes a **mode**, never arguments: the server builds `picks -mode <mode>` from
a closed enum, and the only job it can aim at is `shorted-picks`.

**Building first fundamentals coverage** (the reason `run_picks_job` exists):
`fundamentals` works through the whole universe in priority order (due filers,
never-attempted codes by market cap, failures, then the stalest) within a budget
of about 170 minutes, then `filings` (a deterministic, fail-closed rebuild of the
rows parsed from ASX results filings; exit 10 means it refused to write), then
`refresh`. Coverage is built when the public server's `get_strategy_picks`
reports `fundamentals_rows_count` near the codes our data providers publish
statements for (about three quarters of `universe_count`); run `fundamentals`
again for any remainder. The tool's `next` field says this after each run. The
nightly 15:00 UTC schedule runs `all` from then on. A second run is refused
while one is in flight (`force` overrides, for a stuck execution; the job's own
lease still keeps two executions from writing at once).

**Connected before `jobs:run` existed?** Your token carries only
`news:publish`. The publish tools keep working; the picks tools answer with a
tool error naming the missing scope. Disconnect and reconnect the connector to
approve it (an empty scope request is granted the whole admin vocabulary).

**This connector exposes only admin tools; it is not a superset of
the public server.** A research client — one that needs short positions,
strategy picks, fundamentals, housing, economy or the register of interests —
must also connect the public URL, `https://api.shorted.com.au/mcp`, as its own
connector.

## Job visibility and freshness

- Cloud Run Jobs are discovered across `JOBS_RUN_REGIONS` (defaults include
  `australia-southeast2` and `us-central1`). Job, execution and scheduler lists
  are paginated. Every execution page is scanned for active runs, so an older
  run remains visible after newer executions finish. Same-name jobs in different
  regions remain distinct; specify `region` when inspecting them.
- Cloud Scheduler triggers come from `JOBS_SCHEDULER_REGION`. A successful HTTP
  trigger means the target accepted the request, **not** that downstream work
  finished. The response identifies this coverage limitation.
- Housing rigs report `crawl_run_status` in Shorted. The overview includes
  freshness, failures and last-run health. **Individual housing crawl tasks live
  in Brandbrain and are not exposed by this connector.** A rig record is not a
  live process inventory. External CI jobs are also outside this server's scope.
- Enrichment queue counts cover every queued/processing row; use
  `list_enrichment_jobs` for per-task state, timestamps and failures. A task stuck
  in `processing` is not proof its worker is alive.
- The latest attributable `sync_status` row adds short-sync record counts and
  detects successful containers that did no work.

The GCP snapshot has a 60-second cache. Check `observedAt`, `stale`, `incomplete`,
`warnings` and `sources`; unavailable sources are never silently treated as
healthy or empty. `get_job_execution` reads execution state directly. Poll with
backoff instead of rapidly reloading the fleet. The overview's Refresh respects
the cache, and execution history uses explicit pagination.

## Native MCP extensions

The implementation follows the [OpenAI MCP extensions wire specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md):

- `list_async_jobs` accepts `{}` and declares global/sidebar and thread entrypoints.
- `ui://shorted/admin-jobs-v1.html` is an embedded MCP App with a restrictive CSP;
  data flows through authenticated host tool calls, with no browser API token.
- `search_job_mentions` advertises `mentions/search` and app visibility.
  `shorted-admin://jobs/{region}/{name}` is resolved through `resources/read`,
  requiring `jobs:read`, and marked private and immediately stale for caching.
- The app consumes its initial tool result, follows host light/dark theme and
  `/jobs/{region}/{name}` deep links, and supports explicit context/chat actions.
  Clients without these extensions can use the ordinary tools.

**Reconnect existing admin connections after deployment** to grant `jobs:read`.
Older `news:publish` and `jobs:run` grants continue working for their existing tools;
they do not silently acquire monitoring privileges. A plugin-aware host is needed
for sidebar/chat entrypoints; publishing/installing a plugin is separate from
serving the metadata.

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
- **Separate scope vocabulary.** `news:publish`, `jobs:run` and `jobs:read` are not in
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
