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
and approve **jobs:read**, **news:publish**, **jobs:run**, **users:read** and
**crawl:authorize**.
For a monitoring-only client, request only `jobs:read`; leave out `users:read`
and `crawl:authorize` unless the client needs personal data or the housing
crawl. The connector then appears in every Claude session (including Claude
Code on the web) with twenty-five tools:

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
| `run_paid_probe` `{}` | `jobs:run` | Runs the paid-feature probe on the web app inside the call and returns each step. Bounded at 85 seconds. A second call while a run is in flight returns `inProgress: true` at once and starts nothing. |
| `alerts_status` `{}` | `jobs:read` | The alerts pipeline: monitor counts across owners by status and cadence, the caller's own monitors, the ten newest evaluator runs and the twenty newest events. Other owners' events carry no monitor id and no error text (the error text can name their subscription status); no address or user id is returned for anyone. |
| `find_alert_crossing` `{code?, threshold?, condition?}` | `jobs:read` | The most recent report date on which a stock crossed a threshold (default 5, `above`), by the evaluator's rule over the last 20 report dates. Read-only. |
| `run_alerts_smoke_test` `{code?, threshold?, condition?, date?}` | `jobs:run` | The end-to-end check on the caller's own account: creates or reuses one daily monitor, then replays one report date for the caller. The replay also emails the caller's other daily monitors that crossed on that date. A real email goes to the caller's verified address. Refuses without Premium or a verified address, and refuses a date where the monitor already has an event. |
| `alerts_smoke_result` `{monitor_id, date, execution?}` | `jobs:read` | What the replay did for one of the caller's monitors on one date: the event row (with `createdAt`, `runId`) and, with `execution`, the job's state. A row written before that execution started is flagged `predatesExecution`. |
| `delete_alert_monitor` `{monitor_id}` | `jobs:run` | Deletes one of the caller's own monitors and its events. Refused for any other monitor. |
| `housing_crawl_rigs` `{rig_id?}` | `crawl:authorize` | Lists shorted's housing crawl allowlist (`housing_ingest_rigs`): each subject, whether it is enabled and when it was added. The note is not returned. With `rig_id`, also BrandBrain's `housing_crawl_v1` grant for that rig and whether shorted's row for its `workload_subject` exists and is enabled. Read-only. |
| `housing_crawl_authorize` `{rig_id \| subject, enabled, note?, confirm?}` | `crawl:authorize` | Turns a BrandBrain rig's housing crawl on or off. Give **exactly one** of `rig_id` or `subject`. Enabling needs `rig_id`, `confirm: true`, and runs GET, then PUT of the grant, then the shorted allowlist write for the `workload_subject` BrandBrain returns. Disabling by `rig_id` writes shorted first, then revokes the grant, and still revokes when shorted fails. Disabling by `subject` (`rig:<id>`, from `housing_crawl_rigs`) changes only shorted's row and never calls BrandBrain (`brandbrain: not_attempted`), so it works while BrandBrain is down. Reports each side (`shorted`, `brandbrain`) separately. A PUT with an unknown outcome is reported as `unknown` and never retried. Idempotent. |

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

Signed-in users' own alerts are a different connection and a different scope. The
public `/mcp` server offers six alert tools (`list_my_alerts`, `create_alert`,
`pause_alert`, `resume_alert`, `delete_alert`, `list_my_alert_history`) only to a token
carrying `alerts:write`, which is never granted by default. They act on the caller's own
account and never on another owner's. The admin tools here, including the smoke test
(`run_alerts_smoke_test`), stay on this connector and this scope vocabulary. See
`web/public/docs/mcp-markdown.md`, "Your alerts", and CLAUDE.md, "MCP server".

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
  operator grant, the status, the paid tier and the 72-hour period grace the paid
  features apply. A null status is the one exception. The product cannot read
  such a row, so it grants nothing, and the audit reports it as `null_status`.
- **Unread is not empty.** A source that fails is named in `sources`, and its
  section is `null`; a count is absent, not zero. An empty list means the source
  was read and found nothing.
- **Drift is by customer.** Stripe's subscriptions are grouped by customer, and
  each customer's best subscription is chosen by the web's ranking: active, then
  trialing, past_due, unpaid, then the newest ended one. That subscription is set
  against the one row that holds the customer. The row is found by its customer
  id, wherever it is keyed, so a row under another email still counts. Findings:
  - `paid_without_mirror`: the worst case. An active or trialing subscription
    whose customer has no row, or whose row grants no paid access. Money taken,
    no access.
  - `unpaid_without_mirror`: a past-due or unpaid customer with no row. Owed
    money, not access.
  - `subscription_user_mismatch`: the customer's best live subscription was
    bought for one user id (Stripe's `metadataUserId`), and the one row that holds
    the customer is keyed to another. The real payer has no row, and the row's user
    holds the access. This is the case of an account deleted and recreated, or a
    subscription stamped onto a stale row during a deploy. The detail names both
    user ids and nothing else.
  - `entitled_without_stripe`: access with no live subscription behind it.
  - `stale_subscription_id`: low severity. The row does not name the customer's
    current subscription, though its state can already be right.
  - `status_mismatch` (the webhook's own mapping: unpaid is recorded as past_due),
    `period_end_mismatch` (more than an hour apart), `missing_period_end`,
    `cancel_mismatch`, `null_status`, `duplicate_email` (once per email) and
    `email_keyed_user_id` (a legacy row keyed by an email, which no uid can match).
- **An ambiguous email is partial.** Stripe can match one email to more than one
  customer. Each is read and compared with its own row, up to ten; `notes` says how
  many were left out. The Stripe source is `partial`, because the subject may hold
  more customers than the answer shows. A matched customer that cannot be read makes
  the source `unavailable`, never `partial`.
- **Stripe is asked with the email as typed.** The mirror and the account are read
  with the email in lower case. The web app retries Stripe in lower case itself.
- **A row updated in the last 15 minutes is left out of drift**, because the
  Stripe webhook may still be in flight. `notes` says how many were left out, and
  the row is marked `recentlyUpdated`.
- **Stripe ids never leave the server.** The one exception is
  `stripeDashboardUrl`, which needs a Stripe login.
- **Usage.** Chat counts come from `chat_conversations` and `chat_messages`, and
  count only the user's own messages. Sends by outcome come from
  `chat_usage_events` (migration 000145, the send-limits ledger). That ledger is
  on the chat-limits branch and is not in every database: where it is absent the
  output says "not in this database", and sends are unknown, not zero. Metered requests come from `api_usage_monthly`, which the rate limiter
  writes. `user:<uid>` is the API-token and signed-in browser identity, and
  `oauth:<uid>` is the MCP connector's; the two are reported apart. Unlimited
  tiers are not metered, so a zero there is no metering, not no use. It is the
  rate limiter's count, not a billing ledger.
- **`list_billing_exceptions` counts every kind it checked, zero included.** A
  kind missing from `counts` was not checked, and `notes` says why. A live Stripe
  list that was cut at its limit does not run `entitled_without_stripe`.

The probe reports to one Telesis cron monitor per step, named
`paid-feature: <step>`: `entitlement`, `chat`, `api_token`, `gates` and `all`.
The monitors must exist in the Telesis service configured by
`TELESIS_SERVICE_ID`. `paid_feature_status` lists each one that exists, and
says so when none does.

`paid_feature_status` (`jobs:read`) reads the Telesis cron monitors the probe
reports to, one per feature: `paid-feature: entitlement`, `chat`, `api_token`,
`gates` and `all`. `armed` is Telesis' own flag: it is true only after the monitor's first
check-in. An armed monitor alerts when a run is missed; an unarmed one has not
reported yet, so a missed run cannot alert. `configured: false` means Telesis is not set up on this
deployment; that is not an error. The Telesis setup is in "Jobs on the omega
cluster" above.

`run_paid_probe` (`jobs:run`) runs the probe on the web app
(`POST /api/internal/paid-probe`) inside the call. The probe exercises each paid
feature as a subscriber would and returns every step with the call.

- **Bounded at 85 seconds.** The admin server bounds every request at 90 seconds,
  and the probe's worst case on the web side is about 75, so the call is given
  85. A run that exceeds it returns a tool error. The run may still finish on the
  web app, so check `paid_feature_status` for its outcome.
- **One run at a time.** The connector holds an in-flight guard. A second call
  while a run is in flight returns `inProgress: true` at once, with the message
  "a probe run is already in progress", and starts nothing. It does not queue.
  The guard is released when the run ends or the call is cancelled.

## Alerts smoke test (the alert tools)

The short-interest alerts pipeline is checked end to end from Claude, on the
caller's own account and nobody else's. The runbook is `docs/alerts-runbook.md`
"Prod smoke test"; the flow is:

1. `find_alert_crossing` picks a stock and a report date it crossed on, by the
   evaluator's own rule: the previous reading below the threshold and the latest
   at or above it, both to two decimal places, against the report before it, over
   the last 20 report dates. It is the same window `shorted alerts` reads, so a
   date outside it cannot be replayed. `below` is refused: the evaluator has no
   below rule, so a below search would report crossings no alert sends.
2. `run_alerts_smoke_test` checks, in this order, before it writes anything: the
   caller's Premium entitlement (the same rule the paid features use; the evaluator
   skips an account without it), and the caller's **verified** address. It then
   reuses an identical active daily monitor or creates one through the same rule
   the web app uses (`services/shorts/internal/services/shorts/alerts_core.go`),
   and starts `shorted-alerts-replay` with the argv `alerts -date <D> -user <uid>
   -canary off`, built here from the date and the verified token's uid and never
   from tool input. The reply masks the address (`b***@shorted.com.au`).
3. `alerts_smoke_result` (after one to two minutes) reads the event row on that
   date (email status, whether Resend accepted it, any error) and the execution.
   A second replay of the same date sends nothing: the evaluator writes one event per
   monitor per date.
4. The smoke monitor stays active after the check. It emails again on every future
   crossing until it is paused (the one-click link in the email) or deleted. Pause
   it from the email, then `delete_alert_monitor` removes it.

**The verified address.** Step 2 reads the caller's address from the web app's
`admin-users` route (`lookup` by `uid`), and uses it only when the account is enabled
and Firebase says the address is verified. That is the same rule the public alerts
path applies to its verified token claims (`verifiedAccountEmail` in
`services/shorts/internal/services/shorts/firebase_users.go`). Without
`INTERNAL_SERVICE_SECRET` the server cannot read it and the smoke test refuses. A
refusal names the reason (not verified, disabled, no account, or the web app still
rolling out a deploy, which clears within minutes), and nothing is created.

Ownership is structural. Every alerts tool acts for the verified token's uid, and
no input names an owner (an owner field in the input is refused by the schema).
`alerts_status` shows other owners' counts and events, but never their addresses,
user ids, or, for their events, monitor ids and error text. `alerts_smoke_result` and
`delete_alert_monitor` reach only the caller's own monitors (another owner's monitor
reads as not found).

The replay job is fenced. `shorted-alerts-replay` sets `ALERTS_REPLAY_ONLY=true`, so
a live run without both `-date` and `-user` is refused by the jobs binary itself.
The scheduled CronJob does not set it.

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

## Housing crawl authorization (`crawl:authorize`)

A BrandBrain rig pushes housing listings into shorted only when BOTH switches are on:

1. **shorted's allowlist**, the `housing_ingest_rigs` row for the rig's JWT `sub`
   (migration `000150`). The ingest checks it on every push and caches the answer for
   a minute. A missing row means refused.
2. **BrandBrain's `housing_crawl_v1` operator grant** on the rig. The grant route is
   `/api/v1/fleet/rigs/{rig_id}/housing-crawl/grant`, reached with
   `BRANDBRAIN_HOUSING_GRANT_TOKEN`. That credential works on that route only.

The subject is BrandBrain's `workload_subject`, read from its GET and never derived.
Config: `BRANDBRAIN_API_URL` (default and only allowed value
`https://api.brandbrain.dev`; any other host, port, path or credential is refused at
start) and `BRANDBRAIN_HOUSING_GRANT_TOKEN`, delivered from the Secret Manager secret
`brandbrain-housing-grant-token` by the `shorts-api` module
(`brandbrain_housing_grant_secret_exists`, off until the secret is provisioned). Without
the token the write tool answers `not_configured` and the read tool still lists rows.

The brandbrain client refuses redirects, applies a 10-second timeout to each request and
never puts the token in an error or a log line. The note on an allowlist row is stored but
never returned by either tool.

- **Enable** (`confirm: true` required): GET, then PUT `granted: true`, then the allowlist
  upsert. A 404 on the GET stops with nothing written. An unknown PUT outcome stops before
  shorted is touched.
- **Disable by `rig_id`**: the subject comes from BrandBrain's GET, so shorted's row is
  written first and the revoke follows. The revoke is still attempted when the shorted
  write fails. When the GET fails, the subject cannot be resolved: the tool reports
  `shorted: failed`, still attempts the revoke, and says to disable by subject instead.
- **Disable by `subject`**: the kill switch. See the next section.
- **`brandbrain: unknown`** means a PUT timed out or returned a 5xx. Nothing is retried
  automatically. Run `housing_crawl_rigs` with the `rig_id`, then run the tool again. Both
  operations are idempotent.

### Kill switch with BrandBrain unavailable

Cut a rig off immediately, without BrandBrain. Shorted's allowlist alone decides whether
the rig's pushes are admitted, so the switch needs only shorted's database:

1. Find the rig's subject. Run `housing_crawl_rigs` with no `rig_id`. It lists each
   allowlist subject (`rig:<id>`) and whether it is enabled. It needs no BrandBrain.
2. Disable it: `housing_crawl_authorize` with `subject: "rig:<id>"` and `enabled: false`.
   The result is `shorted: disabled` (or `unchanged`, or `not_present` if no row exists),
   and `brandbrain: not_attempted`. No BrandBrain token is needed.
3. Within about a minute the ingest refuses the rig's pushes: it caches the allowlist for
   60 seconds.
4. When BrandBrain is reachable again, revoke its grant too:
   `housing_crawl_authorize` with `rig_id` and `enabled: false`. The shorted side is
   `unchanged` and BrandBrain reports `revoked`.

Enabling is never possible by subject. A subject is only valid with `enabled: false`, and
enabling needs `rig_id` (and `confirm: true`), so BrandBrain always supplies the subject.
Give exactly one of `rig_id` or `subject`: both, or neither, is refused.
The subject must be `rig:` followed by 1 to 100 letters, digits, dots, underscores or
hyphens, starting with a letter or digit. It mirrors the BrandBrain issuer's rig subject.

Operator failure modes:

- **"BRANDBRAIN_HOUSING_GRANT_TOKEN is not configured"** — the secret is not provisioned
  or the `shorts-api` variable is off. Nothing was written.
- **"BrandBrain rejected the grant token for this route"** — the token is wrong or
  expired. Rotate the Secret Manager version. Nothing was written.
- **"rig_not_found"** — the id is not a BrandBrain rig. Nothing was written.

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
- **Separate scope vocabulary.** `news:publish`, `jobs:run`, `jobs:read`, `users:read` and `crawl:authorize` are not in
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
  `shorted-news-publish`, `shorted-picks`, `shorted-alerts-replay`;
  `scripts/tests/picks-job.test.mjs` counts them). The argv is never caller text:
  a slug matched against a pattern, a mode matched against an enum, a date and a
  verified uid for the alerts replay.
- **Separate registry.** The admin tools are not in `mcp.Registry()`, so the
  public catalog, read-only annotations and payload budgets are untouched.

Files: `services/shorts/internal/mcp/admin.go`, `internal/jobmonitor/publish.go`,
`internal/jobmonitor/picks.go`, `internal/oauth/resources.go`,
`internal/services/shorts/admin_check.go`, `web/src/app/api/internal/admin-check/`.

## Failure modes

- **"the verified address could not be read, so nothing was created"** from
  `run_alerts_smoke_test` — the reason follows: the address is not verified, the account
  is disabled or has no address, or the server has no account store
  (`INTERNAL_SERVICE_SECRET` unset). Nothing was written.
- **"the web app does not answer uid lookups yet"** — the API was deployed ahead of the
  web app (the two ship in one deploy, API first). Retry in a few minutes. Nothing is
  cached, so the next call after the rollout works.
- **"already has an alert event for <date>"** from `run_alerts_smoke_test` — the monitor
  has a row for that date (an earlier smoke run, or the scheduled run fired on it). A
  replay would send nothing, and the old row would read as this run's result, so nothing
  is started. Pick another date with `find_alert_crossing`, or delete the monitor and run
  again.
- **"the alerts replay is already running"** from `run_alerts_smoke_test` — a replay
  is in flight. Wait for it, then retry. The monitor it used stays in place.


- **"forbidden: administrator access required"** on every call — the admin
  check is failing (web endpoint unreachable, `INTERNAL_SERVICE_SECRET`
  mismatch between Vercel and Cloud Run, or the email is unverified / not on
  `ADMIN_EMAILS`). Look for `admin check:` in the shorts API logs.
- **`invalid_target`** from the consent screen — the API was deployed without
  `INTERNAL_SERVICE_SECRET`, so no admin checker exists and the admin resource
  is not grantable (fail closed).
- **"this connection was not granted the jobs:run scope"** as a tool error —
  the connector was authorised before the scope existed; reconnect it.
- **"the web app rejected INTERNAL_SERVICE_SECRET (HTTP 401 or 403)"** from a billing
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
