# ⚠️ LEGACY — not the source of truth

These migrations (`000001`–`011_*`) are a ~3-year-old artifact and have
**diverged** from the canonical, actively-maintained migration set in
**`services/migrations/`**. Production schema changes come from
`services/migrations/`, applied manually via psql (see
`docs/db-performance.md`).

**Do not add new migrations here.** This directory is retained only for
historical reference / old local-dev tooling and may be removed.
