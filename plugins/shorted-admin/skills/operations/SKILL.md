---
name: operations
description: Open Shorted Admin, inspect running or failed asynchronous jobs, execution history, enrichment queues and source health.
---

# Shorted Admin

Use `list_async_jobs` with `{}` to open the interactive admin view and inspect the overall snapshot. Use `status: "running"` for active work, or search by name. Report observation time, incomplete sources and warnings; unavailable data is not proof that no work is running.

Use `list_job_executions` to inspect history, following `nextPageToken`, and `get_job_execution` for fresh status of a selected execution. Preserve job and region identity. Use `list_enrichment_jobs` for queue items, following `nextOffset`. Fleet snapshots are cached for 60 seconds; poll with backoff.

Coverage includes configured Cloud Run regions, the configured Scheduler region, enrichment queue records and housing rigs' last reports. Individual Brandbrain housing tasks and external CI jobs are outside this connector.

Monitoring requires `jobs:read`. Connect or reconnect through the host's OAuth flow using a verified Shorted administrator account if the grant is missing. Never extract credentials or bypass administrator checks.

Only use `publish_news_article` or `run_picks_job` when the user requests the corresponding action. Their `news:publish` and `jobs:run` scopes are separate from monitoring. Read status without starting jobs as a connectivity test. For public research, use the separate public endpoint at https://api.shorted.com.au/mcp.
