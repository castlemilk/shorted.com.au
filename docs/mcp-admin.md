# Admin MCP server — `/mcp/admin`

A separate MCP server for **administrators**, served at
`https://api.shorted.com.au/mcp/admin`. It observes asynchronous jobs and queues,
publishes merged news articles, starts the stock-picks data job, audits
subscribers' billing against Stripe, and runs the paid-feature probe.

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
and approve **jobs:read**, **news:publish**, **jobs:run** and **users:read**.
For a monitoring-only client, request only `jobs:read`; leave out `users:read`
unless the client needs personal data. The connector then appears in
every Claude session (including Claude Code on the web) with eighteen tools:

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
| `people_overview` `{}` | `users:read` | Counts: signed-up accounts (total, verified, new in 7/30 days, signed in within 30 days, by provider), paying subscriptions (active or trialing, by tier and status, cancelling, new in 30 days) and the mailing list (subscribed, unsubscribed, joined and left recently). A source that cannot be read is omitted and named in `warnings`. |
| `list_users` `{query?, sort?, limit?, offset?}` | `users:read` | Signed-up accounts, newest first (or `sort: "last_sign_in"`): uid, email, verified, providers, dates, plan and mailing list membership. `query` is an email substring. Follow `nextOffset`. |
| `list_paying_users` `{status?, limit?, offset?}` | `users:read` | Subscriptions from the Stripe webhook mirror: uid, email, tier, status, period end, cancelling. `status` defaults to `paying` (active or trialing); also `past_due`, `canceled`, `all`, ... Each row carries `entitled` and `entitlementReason`: the product's own verdict for the row, so a paying row that grants nothing reads as such. |
| `list_mailing_list` `{status?, query?, limit?, offset?}` | `users:read` | Mailing list addresses with join and unsubscribe dates; `status` defaults to `subscribed`. |
| `lookup_person` `{email}` | `users:read` | One email across all three: account, subscription and mailing list entry. |
| `check_subscription` `{email}` or `{userId}` | `users:read` | Does one subscriber's access match what they paid for: the account, every mirror row for the email or user id, the entitlement the product applies, the live Stripe customer, drift between the mirror and Stripe, and chat and API usage. Give exactly one key. A source that fails is named in `sources` and its section is `null`. |
| `list_billing_exceptions` `{limit?}` | `users:read` | Billing exceptions across every subscriber, most severe first. `counts` covers every finding; `rows` is the first `limit` (default 25). |
| `paid_feature_status` `{}` | `jobs:read` | Each paid feature's probe monitor in Telesis (`paid-feature: <feature>`): its status, whether it is armed or paused, when it last and next ran, and its five newest runs. |
| `run_paid_probe` `{}` | `jobs:run` | Starts one run of the paid-feature probe on the web app and returns each step. Takes up to about two minutes. A run already in progress is reported, not started twice. |

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

## Users, paying users and the mailing list (`users:read`)

Personal data, so it has its own scope: `jobs:read` never reaches it, and
`users:read` reaches nothing else. Where each answer comes from:

- **Signed-up accounts** are Firebase Auth users. The API cannot list them (the
  same IAM limit as the admin check, below), so the web app answers at
  `POST /api/internal/admin-users` behind `INTERNAL_SERVICE_SECRET`
  (`ADMIN_USERS_URL` overrides; by default it sits beside `ADMIN_CHECK_URL`).
  Firebase lists only in uid order, so each call scans every account (up to
  20,000) and reports `truncated` beyond that.
- **Paying users** are `api_subscriptions`, the table the Stripe webhook keeps.
  It is what the webhook last recorded, not a live Stripe read, and carries no
  revenue figures.
- **The mailing list** is the `subscriptions` table (prod columns: `id`,
  `email`, `created_at`, `unsubscribed_at`).

The tools return the fewest fields that say who and in what state: email, user
id, dates, plan and status. No display names, photos, phone numbers, Stripe ids
or unsubscribe ids. Every call is logged as `admin personal-data read:
tool=<name> actor=oauth:<uid>` (the arguments are not logged; they can be an
email). Reconnect the connector after deploying to approve `users:read`.

## Billing audit and the paid-feature probe

Two questions an administrator asks about a paying customer: does what they paid
for match what they can use, and do the paid features work right now?

- **Stripe is read live through the web app**, not from the mirror alone:
  `POST /api/internal/billing` behind `INTERNAL_SERVICE_SECRET`, at the same
  origin as `ADMIN_CHECK_URL`, as `admin-users` is. Without the secret, Stripe is
  named unavailable and nothing is guessed.
- **The verdict is the product's own.** `entitled` is `ResolveEntitlement`: the
  operator grant, the status, the paid tier and the 24-hour period grace the paid
  features apply. The tools cannot disagree with what a customer can use.
- **Unread is not empty.** A source that fails is named in `sources`, and its
  section is `null`; a count is absent, not zero. An empty list means the source
  was read and found nothing.
- **Drift** compares each mirror row with Stripe's live subscription for its
  customer. `paid_without_mirror` is the worst case: a live Stripe subscription no
  row tracks, or a row that grants no access while Stripe says active or trialing
  (money taken, no access). `entitled_without_stripe` is access with no live
  subscription behind it. The others are `status_mismatch` (the webhook's own
  mapping: unpaid is recorded as past_due), `period_end_mismatch` (more than an
  hour apart), `missing_period_end`, `cancel_mismatch`, `duplicate_email` and
  `email_keyed_user_id` (a legacy row keyed by an email, which no uid can match).
- **A row updated in the last 15 minutes is left out of drift**, because the
  Stripe webhook may still be in flight. `notes` says how many were left out, and
  the row is marked `recentlyUpdated`.
- **Stripe ids never leave the server.** The one exception is
  `stripeDashboardUrl`, which needs a Stripe login.
- **Usage.** Chat counts come from `chat_conversations` and `chat_messages`, and
  count only the user's own messages. Sends by outcome come from
  `chat_usage_events` (migration 000145, the send-limits ledger). That ledger is
  on the chat-limits branch and is not in every database: where it is absent the
  output says "not in this database", and sends are unknown, not zero. API
  requests come from `api_usage_monthly`: the rate limiter's count, not a billing
  ledger.
- **`list_billing_exceptions` counts every kind it checked, zero included.** A
  kind missing from `counts` was not checked, and `notes` says why. A live Stripe
  list that was cut at its limit does not run `entitled_without_stripe`.

`paid_feature_status` (`jobs:read`) reads the Telesis cron monitors the probe
reports to, one per feature: `paid-feature: entitlement`, `chat`, `api_token`,
`gates` and `all`. `armed` means the monitor expects runs (it is not paused), so
a missed run alerts. `configured: false` means Telesis is not set up on this
deployment; that is not an error. The Telesis setup is in "Jobs on the omega
cluster" above.

`run_paid_probe` (`jobs:run`) starts one run of the probe on the web app
(`POST /api/internal/paid-probe`), which exercises each paid feature as a
subscriber would and returns every step. A run already in progress returns
`inProgress: true` and starts nothing. The probe is not cut at the admin
server's 90-second request bound; it has its own 150-second budget. A run that
takes longer than about two minutes can still reach the connector as a Cloudflare
524 (Cloudflare gives up on a silent response at 120 seconds) while the probe
completes on the server, so check `paid_feature_status` for its outcome.

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

## Jobs on the omega cluster (Telesis)

Jobs cut over to the omega Kubernetes cluster keep their Cloud Run job but
have their Cloud Scheduler trigger paused, so Cloud Run and Cloud Scheduler
alone describe them as paused and long overdue. Their runs are reported to
Telesis cron monitors by `cronjob-reporter`, and the job monitor reads them
there (`services/shorts/internal/jobmonitor/cluster.go`). The same rows serve
`list_async_jobs` and `/admin`.

- A **paused** trigger whose name is a monitor's name, or a monitor's name
  plus `-schedule`, becomes state `CLUSTER` (`runner: kubernetes`) with that
  monitor's newest run, last success, next expected run and terminal reason.
  A paused trigger with no monitor stays paused.
- The row takes the newest cluster run when it is newer than the last Cloud
  Run execution (Run now still uses Cloud Run), and each `CLUSTER` trigger is
  also judged on its own runs: a failed weekly digest is not hidden behind
  the job's 2-hourly successes. A missed run reads overdue, not failed.
- `sources` names `telesis_cron_monitors` as `available`, `degraded` (the
  rows fall back to Cloud Run) or `unconfigured`.

Setup, once:

1. In Telesis (Settings > Security), create a project token with role
   **read**, scoped to the `shorted.com.au scheduled jobs` service. Telesis
   admits project tokens to cron-monitor reads only from skunkworq/uptime's
   project-token read access onwards; earlier, every project token was
   refused.
2. Store it as Secret Manager secret `TELESIS_API_TOKEN` in the prod project.
3. In `terraform/environments/prod/main.tf`, set `telesis_secret_exists = true`
   with `telesis_org_id` and `telesis_service_id`, and deploy.

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
- **Separate scope vocabulary.** `news:publish`, `jobs:run`, `jobs:read` and `users:read` are not in
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
- **"the web app rejected INTERNAL_SERVICE_SECRET (HTTP 401)"** from a billing
  tool or `run_paid_probe` — the API's `INTERNAL_SERVICE_SECRET` does not match
  the web app's. Stripe and the probe are unreadable until they match; the
  mirror-only checks still answer.
- **`configured: false`** from `paid_feature_status` — the Telesis token or
  organization is unset on this deployment (see "Jobs on the omega cluster").
- **`chat_usage_events` "not in this database"** in `check_subscription` — the
  send-limits ledger (migration 000145) is not applied here. Chat sends are
  unknown, not zero.
- **"job execution is not configured in this deployment"** from `run_picks_job`
  — the API's service account lacks `run.developer` on `shorted-picks`
  (Terraform `shorts_api_picks_overrides` not applied) or the job monitor has no
  project; a 403 from Cloud Run surfaces the same way. `gcloud run jobs
  get-iam-policy shorted-picks --region australia-southeast2` should list the
  shorts API SA with `roles/run.developer`.
