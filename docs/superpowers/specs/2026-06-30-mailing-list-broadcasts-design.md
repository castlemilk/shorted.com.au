# Mailing-list broadcasts (weekly report, monthly report, weekly news digest)

**Date:** 2026-06-30
**Status:** Design — approved, pending spec review
**Owner:** Ben Ebsworth

## 1. Goal

Email our newsletter list when we publish a **weekly report**, a **monthly report**, or a
new **weekly news digest** — each broadcast carrying a compliant, one-click **unsubscribe**.

Sends go out via an **admin review-then-send** step (publishing queues a draft; a human
approves it), so a blast to the list is never automatic/accidental.

## 2. Non-goals (YAGNI)

- No Resend Broadcasts/Audiences (would move unsubscribe state out of our DB — see §4).
- No per-recipient delivery-tracking table (low volume; we store a count + status).
- No per-topic subscription preferences — one list, one global unsubscribe. (Revisit if volume grows.)
- No double opt-in. Signup is single opt-in, which is AU-compliant; consent is captured at signup.
- No drag-and-drop email composer — broadcasts are assembled from existing content.

## 3. Source-of-truth constraint

Our Postgres `subscriptions` table is the **single source of truth** for the list and for
unsubscribe state. Everything below preserves that by construction.

> **Prod schema drift (load-bearing):** the live prod `subscriptions` table is **`id uuid, email text UNIQUE`** only — it does **not** match the committed `000001_initial_schema.up.sql` (which declares `SERIAL id, status, created_at, updated_at`). Prod migrations are applied manually and have drifted. The new migration MUST be written `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` against the **real** prod shape and applied manually via the session pooler (port 5432), per project convention.

## 4. Approach: own list + Resend batch (recommended)

Send via Resend's **batch `/emails`** API against our own `subscriptions` table, with our own
signed-token unsubscribe. Rejected alternative: Resend **Broadcasts/Audiences**, which makes
Resend's Audience the authoritative list — a one-click unsubscribe in Gmail would flip Resend's
contact but never reach our DB without a reconciliation webhook/poll. That breaks the
source-of-truth constraint and adds a sync layer. The own-list path has zero sync surface: the
unsubscribe endpoint does one `UPDATE`, and the next send query (`WHERE unsubscribed_at IS NULL`)
excludes it automatically. Low volume (a handful of subscribers) makes batch trivially sufficient
(one `/emails/batch` call, ≤100/call, well under the 5 req/s limit and the 5,000/day bulk threshold).

## 5. The unifying model: draft → review → send

Every content type produces a **draft `broadcasts` row**. The operator reviews and sends it
from `/admin/broadcasts`. This decouples "content was published" from "send an email".

```
weekly report published  ─┐
monthly report published ─┼─→ INSERT broadcasts(status='draft', type, subject, html_body, text_body, source_ref)
weekly news digest (cron)─┘                       │
                                         /admin/broadcasts  ──(operator clicks "Send")──┐
                                                                                        │
   shorts service: SELECT active subs → chunk ≤100 → Resend batch/emails  ◄─────────────┘
   (each: visible unsubscribe link in body + List-Unsubscribe / List-Unsubscribe-Post headers)
                                                   │
                          UPDATE broadcasts SET status='sent', recipient_count, sent_at
```

## 6. Data model

### 6.1 `subscriptions` (alter — `IF NOT EXISTS` against real prod shape)
- `ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz NULL` — active list = `WHERE unsubscribed_at IS NULL`.
- `ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()` (prod lacks it).
- Unsubscribe token is **derived**, not stored: `HMAC-SHA256(id, UNSUBSCRIBE_SECRET)` → hex. Long-lived (no expiry — must work ≥30 days per both Acts). Verified with constant-time compare.

### 6.2 `broadcasts` (new table)
| column | type | notes |
|---|---|---|
| `id` | uuid PK default `gen_random_uuid()` | |
| `type` | text | `weekly_report` \| `monthly_report` \| `news_digest` |
| `subject` | text | email subject |
| `html_body` | text | rendered email HTML (content only; template wraps it) |
| `text_body` | text | plaintext alternative |
| `source_ref` | text NULL | e.g. report slug `2026-W06` / `2026-01`, or digest week |
| `status` | text | `draft` \| `sending` \| `sent` \| `failed`, default `draft` |
| `recipient_count` | int default 0 | filled on send |
| `error` | text NULL | last send error if `failed` |
| `created_at` | timestamptz default now() | |
| `sent_at` | timestamptz NULL | |

Unique index on `(type, source_ref)` so re-publishing the same report/week doesn't create
duplicate drafts (`ON CONFLICT DO NOTHING`, mirrors the report upsert idempotency).

## 7. Components

### 7.1 Draft creation
- **Weekly/monthly report** — `services/weekly-report-generator` (Go; already has the report content + DB) inserts a `weekly_report`/`monthly_report` draft right after `storeReport()` succeeds (main.go ~401), only when `published_at` was set (quality-gated). Subject + html derived from the report headline/summary + a link to `/reports/{weekly|monthly}/{slug}`.
- **Weekly news digest** — a new **digest assembler** (Go; new `-mode digest` in `services/news-aggregator`, which already has DB + runs on a scheduler) assembles the week's top matched `news_articles` + new `editorial_takes` into a `news_digest` draft. Run weekly via Cloud Scheduler (Fri, aligning with the weekly report).

### 7.2 Send service (shorts Go service)
- New **admin-authed** endpoint (reuses `INTERNAL_SERVICE_SECRET` bearer, the jobmonitor pattern): `POST /api/admin/broadcasts/{id}/send`.
- Flow: mark `sending` → `SELECT email,id FROM subscriptions WHERE unsubscribed_at IS NULL` → chunk ≤100 → for each recipient build the email (template + per-recipient unsubscribe URL + `headers`) → `resend.batch.send` → on success mark `sent` + `recipient_count`; on error mark `failed` + `error`. Retry/backoff on 429. Idempotent: refuses to send a broadcast already `sent`.
- Reuses the existing Resend pattern from `register/notify.go` (same `RESEND_API_KEY`).
- Also exposes `GET /api/admin/broadcasts` (list) for the admin UI.

### 7.3 Unsubscribe (compliant, no-login, indefinite)
- Public `Unsubscribe(token)` RPC on the register service (visibility `PUBLIC`, like `RegisterEmail`): verifies the HMAC token → `UPDATE subscriptions SET unsubscribed_at=now() WHERE id=$1 AND unsubscribed_at IS NULL` (idempotent).
- Web `/unsubscribe?t=<token>` **page** (server component): calls the RPC and renders a branded "You've been unsubscribed" confirmation (+ a "resubscribe" affordance). This is the visible body link.
- Web `POST /api/unsubscribe` **one-click** route (RFC 8058): calls the RPC, returns blank **200**, **no redirect**, idempotent. This is the `List-Unsubscribe` header target.

### 7.4 Email template
Shared HTML wrapper (`text` + `html`): Shorted logo/header, the broadcast content, and a
**footer** with sender identification + unsubscribe. Plaintext alternative always included.

### 7.5 Admin UI
`/admin/broadcasts` (gated by existing admin auth): table of drafts (type, subject, source, est. recipients) with a **preview** (renders `html_body`) and a **Send** button → `POST /api/admin/broadcasts/{id}/send`; plus sent history (status, recipient_count, sent_at). Server action sends the `INTERNAL_SERVICE_SECRET` header (same pattern as `getJobsOverview`).

## 8. Compliance (AU Spam Act 2003 — sender is an AU entity)

- **One-click unsubscribe (RFC 8058):** every send sets `List-Unsubscribe: <https://shorted.com.au/api/unsubscribe?t=TOKEN>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. DKIM covers these automatically on the verified `shorted.com.au` domain. POST returns 200, no redirect.
- **Visible unsubscribe** link in the footer (same tokenised URL → `/unsubscribe?t=`).
- **Functional, no-login, ≥30 days, honored immediately** (one `UPDATE`; well under AU's 5-business-day rule).
- **Sender identification (footer):** `Gamma Systems Pty Ltd · ABN 52 682 863 690 · shorted.com.au · support@shorted.com.au`. (Registered entity confirmed via ABR; AU does not require a physical address.)
- **Consent:** single opt-in captured at signup (the existing subscribe form).

## 9. Config / secrets / env

- Reuses the existing prod `RESEND_API_KEY` secret (already in Secret Manager + bound to the shorts service).
- New secret `UNSUBSCRIBE_SECRET` (HMAC key) in Secret Manager → bound to the shorts service (gated like `resend_secret_exists` so deploy is safe before it exists). Same value available to the web layer only if the web mints tokens — but tokens are minted **server-side in Go** at send time and verified in Go, so only the shorts service needs it.
- From: `Shorted <updates@shorted.com.au>`; Reply-To: `support@shorted.com.au`. (Free — Resend bills by volume, not by from-address; any address on the verified domain works.)
- Digest scheduler: Cloud Scheduler (region `australia-southeast1`) → news-aggregator `-mode digest`, weekly.

## 10. Testing

- **Unit (Go):** token sign/verify (HMAC round-trip, constant-time, tamper → reject); broadcast send builds correct per-recipient headers + excludes unsubscribed; idempotent send refuses `sent`; batch chunking >100.
- **Unit (web):** `/api/unsubscribe` POST returns 200 no-redirect; `/unsubscribe` page renders confirmation.
- **Integration:** publish a report → draft row created (idempotent on re-publish); send → recipients counted, unsubscribed excluded.
- **Manual e2e (prod, controlled):** create a draft, send to a test address, confirm receipt + Gmail's one-click unsubscribe flips the row + the next send excludes it. (Use a test subscriber row, clean up — `subscriptions` has no per-row PII beyond email.)

## 11. Rollout

1. Migration (manual, session pooler 5432, `IF NOT EXISTS`) — add `subscriptions` columns + `broadcasts` table.
2. Create `UNSUBSCRIBE_SECRET` in prod Secret Manager; terraform binds it (gated).
3. Ship backend (proto `Unsubscribe` + send endpoint + draft creation) + web (unsubscribe page/route + `/admin/broadcasts`).
4. Verify unsubscribe end-to-end with a test row before the first real broadcast.
5. First real send: weekly report draft → review in `/admin` → send.

## 12. Risks / notes

- **Prod schema drift** (§3) — migration must target the real shape, applied manually.
- **Accidental blast** — mitigated by the draft→review→send gate + idempotent unique `(type, source_ref)`.
- **One-click POST must not redirect** (browsers convert redirected POST→GET) — route returns bare 200.
- **Deliverability** — domain already verified (DKIM/SPF present); low volume keeps us off bulk thresholds.
- **Resend free tier** — a handful of subscribers × a few sends/month is far within free limits.
