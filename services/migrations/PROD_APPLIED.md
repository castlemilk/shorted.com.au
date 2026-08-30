# Prod migration ledger

**Prod does not run `migrate up`.** The deploy applies a hardcoded allowlist in
`.github/workflows/terraform-deploy.yml` and then force-writes
`schema_migrations` to version 75:

```sql
DELETE FROM schema_migrations; INSERT INTO schema_migrations (version, dirty) VALUES (75, false);
```

So the database cannot tell you what it has. `schema_migrations` is not merely
stale, it is deliberately meaningless — every deploy resets it to the same
number regardless of what ran. This file is the only record.

## The two ways a migration reaches prod

**Allowlisted** — listed as `-f /migrations/<file>` in `terraform-deploy.yml`.
The deploy **replays it on every run**, so an allowlisted migration MUST be
replay-safe: every statement `IF NOT EXISTS` / `CREATE OR REPLACE`, no bare
`ADD COLUMN`, no `INSERT` without `ON CONFLICT`, and no `DROP … CREATE` of a
materialized view. `000112_add_api_usage_monthly` is the worked example — every
statement guarded, touches no rows.

Most existing housing migrations are **not** replay-safe and must never be added
here: `000086`, `000090`, `000092`, `000054` and others drop and recreate
materialized views, which would rebuild them on every deploy; `000105` inserts
without `ON CONFLICT` and would duplicate rows.

**Hand-applied** — run by an operator against the session pooler (5432) with
`PGOPTIONS="-c statement_timeout=0"`, then recorded below. `task db:prod:apply
FILE=… CONFIRM=prod` is the supported path.

## Baseline

Everything up to and including **`000115`** predates this ledger and is
grandfathered. That is not a claim they are all applied — it is an explicit
statement that their status was never recorded and reconstructing it would mean
auditing 114 files against prod. The guard
(`scripts/tests/migration-drift.test.mjs`) therefore enforces only migrations
**after** the baseline, so drift stops accumulating from here rather than
demanding a retro-audit nobody will finish.

If you do audit a pre-baseline migration, add it under "Applied by hand" with
the date and how you verified it, and it stops being grandfathered.

```
BASELINE: 000115
```

## Applied by hand

One row per migration. `Verified` should say how you know — the query you ran,
not "ran it".

| Migration | Date | By | Verified |
|---|---|---|---|
| `000083_add_state_exposure` | pre-2026-08-29 | (historical) | Removed from the replayed allowlist 2026-08-29. Prod confirmed to hold all three objects it creates: `mv_company_state_exposure` (`pg_matviews`), `idx_mv_company_state_exposure_region_weight` (`pg_indexes`), and `refresh_all_materialized_views` in its **hardened** form (`pg_proc.prosrc ILIKE '%query_canceled%'`). Recorded here because it is applied but no longer replayed. |
