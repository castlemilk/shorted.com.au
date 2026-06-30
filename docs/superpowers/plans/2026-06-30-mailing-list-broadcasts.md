# Mailing-list Broadcasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email the newsletter list (with compliant one-click unsubscribe) when a weekly report, monthly report, or weekly news digest is published, via an admin review-then-send step.

**Architecture:** Our Postgres `subscriptions` table stays the source of truth. Publishing inserts a draft row into a new `broadcasts` table; an operator reviews and sends it from `/admin/broadcasts`; the shorts Go service sends via Resend's batch `/emails` API with a per-recipient HMAC-signed unsubscribe link + RFC 8058 `List-Unsubscribe` headers; the web app hosts the unsubscribe page + one-click POST. Spec: `docs/superpowers/specs/2026-06-30-mailing-list-broadcasts-design.md`.

**Tech Stack:** Go (shorts service, weekly-report-generator, news-aggregator), Connect-RPC + protobuf, PostgreSQL (pgx), Resend HTTP API, Next.js App Router (web), Terraform (Cloud Run + Secret Manager + Cloud Scheduler).

**Phasing (each phase ships + is testable on its own):**
- **Phase A — Unsubscribe foundation:** migration, HMAC token, `Unsubscribe` RPC, web unsubscribe page + one-click route.
- **Phase B — Broadcast send core:** `broadcasts` table, store methods, Resend batch sender, email template, admin send/list endpoints, `/admin/broadcasts` UI. (Send a manually-inserted draft.)
- **Phase C — Draft triggers:** weekly/monthly report draft creation; weekly news-digest assembler + scheduler.

**Conventions (verified, follow exactly):**
- **Store 4-layer pattern** — adding a store method touches all of: `services/shorts/internal/store/shorts/store.go` (interface + impl in `postgres*.go`), `services/shorts/internal/services/shorts/interfaces.go` (`ShortsStore`), `services/shorts/internal/services/shorts/adapters.go` (`StoreAdapter`), `services/shorts/internal/services/shorts/mocks/mock_interfaces.go` (manual mock). The **register service uses `shorts.Store` directly** (`services/shorts/internal/services/register/server.go:13`), so register-only methods need only `store.go` + impl + (optionally) the mock if a register test needs it.
- **Admin REST** — `mux.HandleFunc("/api/admin/...", adminAuthMiddleware(handler))` in `services/shorts/internal/services/shorts/serve.go` (pattern at `:519-523`); auth via `INTERNAL_SERVICE_SECRET` bearer.
- **Public RPC** — add `option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;` (interceptor only allows anonymous on PUBLIC methods) + `import "options/v1/options.proto";`, then `cd proto && buf generate` (revert the unrelated `sdks/java` churn; symlink `web/node_modules` from the main checkout if the worktree lacks it).
- **Proto regen** in a worktree: `ln -sfn <main-checkout>/web/node_modules web/node_modules` then `cd proto && buf generate`; `git checkout -- sdks/java && git clean -fdq sdks/java`.
- **Resend pattern** — mirror `services/shorts/internal/services/register/notify.go` (POST `https://api.resend.com/emails`, `Authorization: Bearer ${RESEND_API_KEY}`).
- **Terraform secret gating** — bind a Secret Manager env only when a `*_secret_exists` bool var is true (see `resend_secret_exists` in `terraform/modules/shorts-api`), so apply is safe before the secret exists.
- **Prod migrations are manual** — apply via the **session pooler (port 5432)** with `PGOPTIONS="-c statement_timeout=0"`, written `IF NOT EXISTS`. The live prod `subscriptions` table is `id uuid, email text UNIQUE` ONLY (the committed `000001` migration is drifted — do NOT trust it).
- **Commits** on the branch use `git commit --no-verify` (pre-commit hook needs node_modules/golangci which the worktree may lack); still run `tsc`/`go build`/`go vet`/`terraform validate` manually per task.

---

## File Structure

**Phase A**
- Create: `services/migrations/000065_add_broadcasts.up.sql` / `.down.sql` — `subscriptions` ALTER + `broadcasts` table.
- Create: `services/shorts/internal/services/register/token.go` — HMAC unsubscribe token sign/verify.
- Create: `services/shorts/internal/services/register/token_test.go`.
- Modify: `proto/shortedapi/register/v1/register.proto` — add `Unsubscribe` RPC (PUBLIC).
- Modify (regen): `services/gen/proto/go/register/v1/*`, `web/src/gen/register/v1/*`.
- Modify: `services/shorts/internal/services/register/service.go` — `Unsubscribe` handler.
- Modify: `services/shorts/internal/store/shorts/store.go` (+ `postgres.go`) — `UnsubscribeByID`, `GetSubscriberByID`.
- Create: `web/src/app/unsubscribe/page.tsx` — branded unsubscribe page (GET).
- Create: `web/src/app/api/unsubscribe/route.ts` — one-click POST (RFC 8058).
- Create: `web/src/app/actions/unsubscribe.ts` — client/server action calling the RPC.

**Phase B**
- Modify: `services/shorts/internal/store/shorts/store.go` + new `postgres_broadcasts.go` — broadcast CRUD + `ListActiveSubscribers`.
- Create: `services/shorts/internal/services/shorts/broadcast/sender.go` — Resend batch send + chunking.
- Create: `services/shorts/internal/services/shorts/broadcast/template.go` — HTML/text email wrapper + footer.
- Create: `services/shorts/internal/services/shorts/broadcast/*_test.go`.
- Modify: `services/shorts/internal/services/shorts/serve.go` — `GET /api/admin/broadcasts`, `POST /api/admin/broadcasts/{id}/send`.
- Create: `web/src/app/admin/broadcasts/page.tsx` + `broadcasts-client.tsx` + `web/src/app/actions/getBroadcasts.ts` + `sendBroadcast.ts`.
- Modify: `terraform/modules/shorts-api/{main.tf,variables.tf}` + `terraform/environments/prod/main.tf` — `UNSUBSCRIBE_SECRET` (gated) + `BROADCAST_FROM`/`BROADCAST_REPLY_TO` env.

**Phase C**
- Modify: `services/weekly-report-generator/main.go` — insert broadcast draft after `storeReport`.
- Create: `services/weekly-report-generator/broadcast_draft.go` — build subject/html/text from a report.
- Modify: `services/news-aggregator/main.go` — `RUN_MODE=digest` branch.
- Create: `services/news-aggregator/digest.go` — assemble weekly roundup → broadcast draft.
- Modify: `terraform/modules/<news-aggregator module>` — weekly `news-digest` Cloud Scheduler (region `australia-southeast1`).

---

# PHASE A — Unsubscribe foundation

### Task A1: Migration — subscriptions columns + broadcasts table

**Files:**
- Create: `services/migrations/000065_add_broadcasts.up.sql`
- Create: `services/migrations/000065_add_broadcasts.down.sql`

- [ ] **Step 1: Write the up migration**

`services/migrations/000065_add_broadcasts.up.sql`:
```sql
-- Mailing-list broadcasts + unsubscribe support.
-- NOTE: written IF NOT EXISTS against the REAL prod subscriptions shape
-- (id uuid, email text) — the committed 000001 schema is drifted, do not trust it.
BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_subscriptions_active
  ON subscriptions (email) WHERE unsubscribed_at IS NULL;

CREATE TABLE IF NOT EXISTS broadcasts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type            text NOT NULL CHECK (type IN ('weekly_report','monthly_report','news_digest')),
    subject         text NOT NULL,
    html_body       text NOT NULL,
    text_body       text NOT NULL DEFAULT '',
    source_ref      text,
    status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed')),
    recipient_count integer NOT NULL DEFAULT 0,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz
);

-- Idempotency: re-publishing the same report/week must not create a duplicate draft.
CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcasts_type_source
  ON broadcasts (type, source_ref) WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_status_created
  ON broadcasts (status, created_at DESC);

COMMIT;
```

- [ ] **Step 2: Write the down migration**

`services/migrations/000065_add_broadcasts.down.sql`:
```sql
BEGIN;
DROP TABLE IF EXISTS broadcasts;
DROP INDEX IF EXISTS idx_subscriptions_active;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS unsubscribed_at;
-- created_at intentionally kept (harmless, avoids data loss on re-up).
COMMIT;
```

- [ ] **Step 3: Apply to the LOCAL dev DB and verify**

Run:
```bash
cd services && psql "postgresql://admin:password@localhost:5438/shorts" -f migrations/000065_add_broadcasts.up.sql
psql "postgresql://admin:password@localhost:5438/shorts" -c "\d broadcasts" -c "\d subscriptions"
```
Expected: `broadcasts` table exists; `subscriptions` shows `unsubscribed_at`, `created_at`.

- [ ] **Step 4: Commit**

```bash
git add services/migrations/000065_add_broadcasts.*.sql
git commit --no-verify -m "feat(broadcasts): migration — subscriptions unsubscribe cols + broadcasts table"
```

> **Prod note (rollout, not now):** apply manually via session pooler 5432 with `PGOPTIONS="-c statement_timeout=0"` (Task R1).

---

### Task A2: HMAC unsubscribe token (sign/verify)

**Files:**
- Create: `services/shorts/internal/services/register/token.go`
- Test: `services/shorts/internal/services/register/token_test.go`

- [ ] **Step 1: Write the failing test**

`token_test.go`:
```go
package register

import "testing"

func TestUnsubscribeTokenRoundTrip(t *testing.T) {
	secret := "test-secret-key"
	id := "11111111-1111-1111-1111-111111111111"
	tok := SignUnsubscribeToken(id, secret)
	if tok == "" {
		t.Fatal("expected non-empty token")
	}
	gotID, ok := VerifyUnsubscribeToken(tok, secret)
	if !ok || gotID != id {
		t.Fatalf("verify failed: ok=%v id=%q want %q", ok, gotID, id)
	}
}

func TestUnsubscribeTokenTamperRejected(t *testing.T) {
	secret := "test-secret-key"
	tok := SignUnsubscribeToken("the-id", secret)
	if _, ok := VerifyUnsubscribeToken(tok+"x", secret); ok {
		t.Fatal("tampered token must not verify")
	}
	if _, ok := VerifyUnsubscribeToken(tok, "wrong-secret"); ok {
		t.Fatal("wrong secret must not verify")
	}
	if _, ok := VerifyUnsubscribeToken("garbage", secret); ok {
		t.Fatal("garbage must not verify")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services && go test ./shorts/internal/services/register/ -run TestUnsubscribeToken -v`
Expected: FAIL (undefined: SignUnsubscribeToken).

- [ ] **Step 3: Implement token.go**

`token.go`:
```go
package register

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"hmac"
	"strings"
)

// Token format: base64url(id) + "." + base64url(hmac_sha256(id, secret)).
// Long-lived (no expiry) — must work >=30 days per AU Spam Act / CAN-SPAM.
func sign(id, secret string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(id))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func SignUnsubscribeToken(id, secret string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(id)) + "." + sign(id, secret)
}

func VerifyUnsubscribeToken(token, secret string) (string, bool) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	idBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	id := string(idBytes)
	expected := sign(id, secret)
	if !hmac.Equal([]byte(expected), []byte(parts[1])) {
		return "", false
	}
	return id, true
}
```
> Fix the import block: remove the stray `"hmac"` line — only `crypto/hmac`, `crypto/sha256`, `encoding/base64`, `strings` are needed. (`hmac.Equal` comes from `crypto/hmac`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services && go test ./shorts/internal/services/register/ -run TestUnsubscribeToken -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add services/shorts/internal/services/register/token*.go
git commit --no-verify -m "feat(broadcasts): HMAC unsubscribe token sign/verify"
```

---

### Task A3: Store methods — UnsubscribeByID + GetSubscriberByID

**Files:**
- Modify: `services/shorts/internal/store/shorts/store.go` (interface)
- Modify: `services/shorts/internal/store/shorts/postgres.go` (impl)

- [ ] **Step 1: Add to the `Store` interface** (`store.go`, in the interface block)

```go
	// Newsletter / broadcasts
	UnsubscribeByID(id string) error
	GetSubscriberByID(id string) (email string, unsubscribedAt *time.Time, err error)
```
(Ensure `time` is imported in `store.go`.)

- [ ] **Step 2: Implement in postgres.go**

Append to `services/shorts/internal/store/shorts/postgres.go`:
```go
func (s *postgresStore) UnsubscribeByID(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := s.pool.Exec(ctx,
		`UPDATE subscriptions SET unsubscribed_at = now()
		 WHERE id = $1 AND unsubscribed_at IS NULL`, id)
	return err
}

func (s *postgresStore) GetSubscriberByID(id string) (string, *time.Time, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var email string
	var unsub *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT email, unsubscribed_at FROM subscriptions WHERE id = $1`, id).
		Scan(&email, &unsub)
	return email, unsub, err
}
```
> Verify the receiver name + pool field by reading an existing method in `postgres.go` (e.g. the `RegisterEmail` impl ~line 983) and match it exactly (`s.pool` vs `s.db`).

- [ ] **Step 3: Build**

Run: `cd services && go build ./shorts/...`
Expected: builds (mock for `ShortsStore` may now be incomplete — only if `ShortsStore` includes these; it does NOT need to. Skip mock unless build fails).

- [ ] **Step 4: Commit**

```bash
git add services/shorts/internal/store/shorts/store.go services/shorts/internal/store/shorts/postgres.go
git commit --no-verify -m "feat(broadcasts): store UnsubscribeByID + GetSubscriberByID"
```

---

### Task A4: `Unsubscribe` RPC (proto + regen + handler)

**Files:**
- Modify: `proto/shortedapi/register/v1/register.proto`
- Modify (regen): `services/gen/proto/go/register/v1/*`, `web/src/gen/register/v1/*`
- Modify: `services/shorts/internal/services/register/service.go`
- Modify: `services/shorts/internal/services/register/server.go` (add `unsubscribeSecret` field)

- [ ] **Step 1: Add the RPC + messages to the proto**

In `register.proto`, inside `service RegisterService { ... }` add:
```proto
  // Unsubscribe from the newsletter using a signed token. Public (anonymous).
  rpc Unsubscribe (UnsubscribeRequest) returns (UnsubscribeResponse) {
    option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
  }
```
And at the bottom:
```proto
message UnsubscribeRequest {
    string token = 1;
}
message UnsubscribeResponse {
    bool success = 1;
}
```
(The `import "options/v1/options.proto";` already exists from the subscribe fix.)

- [ ] **Step 2: Regenerate**

Run:
```bash
cd /Users/benebsworth/projects/shorted-broadcasts
ln -sfn /Users/benebsworth/projects/shorted/web/node_modules web/node_modules
cd proto && buf generate
cd .. && git checkout -- sdks/java && git clean -fdq sdks/java
git status --short | grep -vE 'web/node_modules'
```
Expected: only `register.proto`, `services/gen/proto/go/register/v1/*`, `web/src/gen/register/v1/*` changed.

- [ ] **Step 3: Add `unsubscribeSecret` to the server**

In `server.go`, add field + populate from env in `NewRegisterServer`:
```go
type RegisterServer struct {
	registerv1connect.UnimplementedRegisterServiceHandler
	store            shorts.Store
	unsubscribeSecret string
}
// in NewRegisterServer, before return:
return &RegisterServer{
	store:             store,
	unsubscribeSecret: os.Getenv("UNSUBSCRIBE_SECRET"),
}, nil
```
(Add `"os"` import.)

- [ ] **Step 4: Implement the handler** in `service.go`

```go
func (s *RegisterServer) Unsubscribe(ctx context.Context, req *connect.Request[registerv1.UnsubscribeRequest]) (*connect.Response[registerv1.UnsubscribeResponse], error) {
	if s.unsubscribeSecret == "" {
		log.Errorf("unsubscribe: UNSUBSCRIBE_SECRET not configured")
		return nil, connect.NewError(connect.CodeInternal, errors.New("unsubscribe not configured"))
	}
	id, ok := VerifyUnsubscribeToken(req.Msg.Token, s.unsubscribeSecret)
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid token"))
	}
	if err := s.store.UnsubscribeByID(id); err != nil {
		log.Errorf("unsubscribe failed for %s: %v", id, err)
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	log.Infof("unsubscribed subscriber %s", id)
	return connect.NewResponse(&registerv1.UnsubscribeResponse{Success: true}), nil
}
```

- [ ] **Step 5: Build + vet**

Run: `cd services && go build ./shorts/... && go vet ./shorts/internal/services/register/`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add proto/shortedapi/register/v1/register.proto services/gen/proto/go/register/v1 web/src/gen/register/v1 services/shorts/internal/services/register/
git commit --no-verify -m "feat(broadcasts): Unsubscribe RPC (public, token-verified)"
```

---

### Task A5: Web unsubscribe action + one-click route + page

**Files:**
- Create: `web/src/app/actions/unsubscribe.ts`
- Create: `web/src/app/api/unsubscribe/route.ts`
- Create: `web/src/app/unsubscribe/page.tsx`

- [ ] **Step 1: Action that calls the RPC** (`web/src/app/actions/unsubscribe.ts`)

```ts
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { RegisterService } from "~/gen/register/v1/register_pb";
import { SHORTS_API_URL } from "./config";

// Runs server-side (route handler + server component) → use the absolute backend URL.
export async function unsubscribe(token: string): Promise<boolean> {
  const transport = createConnectTransport({ fetch, baseUrl: SHORTS_API_URL });
  const client = createClient(RegisterService, transport);
  try {
    const res = await client.unsubscribe({ token });
    return res.success;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: One-click POST route (RFC 8058)** (`web/src/app/api/unsubscribe/route.ts`)

```ts
import { type NextRequest } from "next/server";
import { unsubscribe } from "~/app/actions/unsubscribe";

export const dynamic = "force-dynamic";

// RFC 8058 one-click target. MUST return a bare 200/202, MUST NOT redirect.
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (token) await unsubscribe(token);
  // Always 200 (idempotent, no enumeration signal).
  return new Response(null, { status: 200 });
}
```

- [ ] **Step 3: Branded unsubscribe page (GET)** (`web/src/app/unsubscribe/page.tsx`)

```tsx
import { unsubscribe } from "~/app/actions/unsubscribe";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: { t?: string };
}) {
  const token = searchParams.t ?? "";
  const ok = token ? await unsubscribe(token) : false;
  return (
    <main className="container mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-bold text-foreground">
        {ok ? "You've been unsubscribed" : "Unsubscribe"}
      </h1>
      <p className="mt-4 text-muted-foreground">
        {ok
          ? "You won't receive any more newsletter emails from Shorted. You can resubscribe any time from the site."
          : "This unsubscribe link is invalid or has expired. If you keep receiving emails, contact support@shorted.com.au."}
      </p>
      <a href="/" className="mt-8 inline-block text-primary hover:underline">
        Return to Shorted →
      </a>
    </main>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -E 'unsubscribe|error TS' | head`
Expected: no errors referencing the new files.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/actions/unsubscribe.ts web/src/app/api/unsubscribe/route.ts web/src/app/unsubscribe/page.tsx
git commit --no-verify -m "feat(broadcasts): web unsubscribe page + RFC 8058 one-click route"
```

> **Phase A is shippable here:** after Task R1 (secret + migration applied) the unsubscribe flow works end-to-end even before broadcasts send.

---

# PHASE B — Broadcast send core

### Task B1: Store — broadcast CRUD + ListActiveSubscribers

**Files:**
- Modify: `services/shorts/internal/store/shorts/store.go` (interface + a `Broadcast` struct)
- Create: `services/shorts/internal/store/shorts/postgres_broadcasts.go`

- [ ] **Step 1: Add types + interface methods to store.go**

```go
type Broadcast struct {
	ID             string
	Type           string
	Subject        string
	HTMLBody       string
	TextBody       string
	SourceRef      string
	Status         string
	RecipientCount int
	Error          string
	CreatedAt      time.Time
	SentAt         *time.Time
}

type Subscriber struct {
	ID    string
	Email string
}
```
Add to the `Store` interface:
```go
	CreateBroadcastDraft(b Broadcast) (id string, err error)   // ON CONFLICT (type,source_ref) DO NOTHING
	ListBroadcasts(limit int) ([]Broadcast, error)
	GetBroadcast(id string) (*Broadcast, error)
	SetBroadcastStatus(id, status, errMsg string, recipientCount int) error
	ListActiveSubscribers() ([]Subscriber, error)
```

- [ ] **Step 2: Implement postgres_broadcasts.go**

```go
package shorts

import (
	"context"
	"time"
)

func (s *postgresStore) CreateBroadcastDraft(b Broadcast) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO broadcasts (type, subject, html_body, text_body, source_ref)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
		RETURNING id`,
		b.Type, b.Subject, b.HTMLBody, b.TextBody, nullIfEmpty(b.SourceRef)).Scan(&id)
	if err != nil {
		// ON CONFLICT DO NOTHING returns no rows → not an error for idempotency.
		if err.Error() == "no rows in result set" {
			return "", nil
		}
		return "", err
	}
	return id, nil
}

func (s *postgresStore) ListBroadcasts(limit int) ([]Broadcast, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := s.pool.Query(ctx, `
		SELECT id, type, subject, html_body, text_body, COALESCE(source_ref,''),
		       status, recipient_count, COALESCE(error,''), created_at, sent_at
		FROM broadcasts ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Broadcast
	for rows.Next() {
		var b Broadcast
		if err := rows.Scan(&b.ID, &b.Type, &b.Subject, &b.HTMLBody, &b.TextBody,
			&b.SourceRef, &b.Status, &b.RecipientCount, &b.Error, &b.CreatedAt, &b.SentAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *postgresStore) GetBroadcast(id string) (*Broadcast, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var b Broadcast
	err := s.pool.QueryRow(ctx, `
		SELECT id, type, subject, html_body, text_body, COALESCE(source_ref,''),
		       status, recipient_count, COALESCE(error,''), created_at, sent_at
		FROM broadcasts WHERE id = $1`, id).
		Scan(&b.ID, &b.Type, &b.Subject, &b.HTMLBody, &b.TextBody, &b.SourceRef,
			&b.Status, &b.RecipientCount, &b.Error, &b.CreatedAt, &b.SentAt)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (s *postgresStore) SetBroadcastStatus(id, status, errMsg string, recipientCount int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := s.pool.Exec(ctx, `
		UPDATE broadcasts
		SET status = $2, error = NULLIF($3,''),
		    recipient_count = CASE WHEN $4 > 0 THEN $4 ELSE recipient_count END,
		    sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
		WHERE id = $1`, id, status, errMsg, recipientCount)
	return err
}

func (s *postgresStore) ListActiveSubscribers() ([]Subscriber, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rows, err := s.pool.Query(ctx,
		`SELECT id, email FROM subscriptions WHERE unsubscribed_at IS NULL ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Subscriber
	for rows.Next() {
		var sub Subscriber
		if err := rows.Scan(&sub.ID, &sub.Email); err != nil {
			return nil, err
		}
		out = append(out, sub)
	}
	return out, rows.Err()
}

func nullIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
```
> Match the receiver/pool field to existing methods. If `nullIfEmpty` already exists in the package, drop the duplicate. The "no rows" string check is brittle — prefer `errors.Is(err, pgx.ErrNoRows)` (import `github.com/jackc/pgx/v5`); use whichever the codebase already uses (grep `ErrNoRows`).

- [ ] **Step 3: Build**

Run: `cd services && go build ./shorts/...`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add services/shorts/internal/store/shorts/store.go services/shorts/internal/store/shorts/postgres_broadcasts.go
git commit --no-verify -m "feat(broadcasts): store broadcast CRUD + ListActiveSubscribers"
```

---

### Task B2: Email template (HTML + text + compliant footer)

**Files:**
- Create: `services/shorts/internal/services/shorts/broadcast/template.go`
- Test: `services/shorts/internal/services/shorts/broadcast/template_test.go`

- [ ] **Step 1: Failing test**

```go
package broadcast

import "testing"

func TestRenderIncludesUnsubAndSenderID(t *testing.T) {
	html := RenderHTML("Weekly report", "<p>hi</p>", "https://shorted.com.au/unsubscribe?t=TOK")
	for _, want := range []string{"https://shorted.com.au/unsubscribe?t=TOK", "Gamma Systems Pty Ltd", "ABN 52 682 863 690", "<p>hi</p>"} {
		if !contains(html, want) {
			t.Fatalf("rendered HTML missing %q", want)
		}
	}
	text := RenderText("Weekly report", "hi", "https://shorted.com.au/unsubscribe?t=TOK")
	if !contains(text, "unsubscribe?t=TOK") || !contains(text, "Gamma Systems Pty Ltd") {
		t.Fatal("text body missing unsubscribe or sender ID")
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 2: Run → fail**

Run: `cd services && go test ./shorts/internal/services/shorts/broadcast/ -run TestRender -v`
Expected: FAIL (undefined: RenderHTML).

- [ ] **Step 3: Implement template.go**

```go
package broadcast

import (
	"fmt"
	"html"
)

const senderFooter = "Gamma Systems Pty Ltd · ABN 52 682 863 690 · shorted.com.au · support@shorted.com.au"

// RenderHTML wraps body HTML in the branded shell with a compliant footer.
// unsubURL is the per-recipient tokenised unsubscribe link.
func RenderHTML(title, bodyHTML, unsubURL string) string {
	u := html.EscapeString(unsubURL)
	return fmt.Sprintf(`<!doctype html><html><body style="margin:0;background:#0b0f16;color:#e7edf5;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px">
<div style="font-size:14px;letter-spacing:2px;color:#ff9a3d;text-transform:uppercase">Shorted</div>
<h1 style="font-size:24px;color:#f4f6fa">%s</h1>
<div style="font-size:15px;line-height:1.6;color:#cdd6e3">%s</div>
<hr style="border:none;border-top:1px solid #233044;margin:32px 0"/>
<div style="font-size:12px;color:#8b97a8">
<p>%s</p>
<p>You're receiving this because you subscribed at shorted.com.au.
<a href="%s" style="color:#ff9a3d">Unsubscribe</a>.</p>
</div></div></body></html>`, html.EscapeString(title), bodyHTML, senderFooter, u)
}

// RenderText is the plaintext alternative.
func RenderText(title, bodyText, unsubURL string) string {
	return fmt.Sprintf("%s\n\n%s\n\n—\n%s\nUnsubscribe: %s\n", title, bodyText, senderFooter, unsubURL)
}
```

- [ ] **Step 4: Run → pass**

Run: `cd services && go test ./shorts/internal/services/shorts/broadcast/ -run TestRender -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/shorts/internal/services/shorts/broadcast/template*.go
git commit --no-verify -m "feat(broadcasts): compliant email template (HTML+text, sender ID + unsubscribe)"
```

---

### Task B3: Resend batch sender

**Files:**
- Create: `services/shorts/internal/services/shorts/broadcast/sender.go`
- Test: `services/shorts/internal/services/shorts/broadcast/sender_test.go`

- [ ] **Step 1: Failing test for chunking**

```go
package broadcast

import "testing"

func TestChunk(t *testing.T) {
	got := chunk(250, 100)
	if len(got) != 3 || got[0] != 100 || got[2] != 50 {
		t.Fatalf("unexpected chunks: %v", got)
	}
}
```

- [ ] **Step 2: Run → fail**

Run: `cd services && go test ./shorts/internal/services/shorts/broadcast/ -run TestChunk -v`
Expected: FAIL (undefined: chunk).

- [ ] **Step 3: Implement sender.go**

```go
package broadcast

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const resendBatchEndpoint = "https://api.resend.com/emails/batch"
const maxBatch = 100

// Recipient is one subscriber to send to.
type Recipient struct {
	ID    string
	Email string
}

// Config carries the send-time settings (from env / secrets).
type Config struct {
	APIKey           string
	From             string // "Shorted <updates@shorted.com.au>"
	ReplyTo          string // "support@shorted.com.au"
	UnsubscribeSecret string
	BaseURL          string // "https://shorted.com.au"
}

type resendEmail struct {
	From    string            `json:"from"`
	To      []string          `json:"to"`
	ReplyTo string            `json:"reply_to,omitempty"`
	Subject string            `json:"subject"`
	HTML    string            `json:"html"`
	Text    string            `json:"text"`
	Headers map[string]string `json:"headers,omitempty"`
}

// SignToken is injected so the package needn't import register (avoids a cycle);
// the caller passes register.SignUnsubscribeToken.
type SignFunc func(id, secret string) string

// Send delivers the broadcast to all recipients in batches of <=100.
// Returns the number of recipients attempted. Non-nil error => mark failed.
func Send(ctx context.Context, cfg Config, subject, title, bodyHTML, bodyText string, recipients []Recipient, sign SignFunc) (int, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	sizes := chunk(len(recipients), maxBatch)
	idx := 0
	for _, n := range sizes {
		batch := make([]resendEmail, 0, n)
		for i := 0; i < n; i++ {
			r := recipients[idx]
			idx++
			tok := sign(r.ID, cfg.UnsubscribeSecret)
			unsubURL := fmt.Sprintf("%s/unsubscribe?t=%s", cfg.BaseURL, tok)
			oneClick := fmt.Sprintf("%s/api/unsubscribe?t=%s", cfg.BaseURL, tok)
			batch = append(batch, resendEmail{
				From:    cfg.From,
				To:      []string{r.Email},
				ReplyTo: cfg.ReplyTo,
				Subject: subject,
				HTML:    RenderHTML(title, bodyHTML, unsubURL),
				Text:    RenderText(title, bodyText, unsubURL),
				Headers: map[string]string{
					"List-Unsubscribe":      fmt.Sprintf("<%s>", oneClick),
					"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
				},
			})
		}
		if err := postBatch(ctx, client, cfg.APIKey, batch); err != nil {
			return idx, err
		}
	}
	return idx, nil
}

func postBatch(ctx context.Context, client *http.Client, apiKey string, batch []resendEmail) error {
	body, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	// One retry on 429.
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, resendBatchEndpoint, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode == 429 && attempt == 0 {
			time.Sleep(time.Second)
			continue
		}
		if resp.StatusCode >= 300 {
			return fmt.Errorf("resend batch status %d", resp.StatusCode)
		}
		return nil
	}
	return fmt.Errorf("resend batch rate-limited")
}

func chunk(total, size int) []int {
	var out []int
	for total > 0 {
		n := size
		if total < size {
			n = total
		}
		out = append(out, n)
		total -= n
	}
	return out
}
```

- [ ] **Step 4: Run → pass**

Run: `cd services && go test ./shorts/internal/services/shorts/broadcast/ -v`
Expected: PASS (TestChunk + template tests).

- [ ] **Step 5: Commit**

```bash
git add services/shorts/internal/services/shorts/broadcast/sender*.go
git commit --no-verify -m "feat(broadcasts): Resend batch sender (chunking, per-recipient unsub headers)"
```

---

### Task B4: Admin endpoints (list + send)

**Files:**
- Modify: `services/shorts/internal/services/shorts/serve.go`

- [ ] **Step 1: Add the list + send handlers** near the existing `/api/admin/jobs` block (~`:519`)

```go
	// Admin: list broadcasts
	mux.HandleFunc("/api/admin/broadcasts", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		items, err := s.store.ListBroadcasts(50)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(items)
	}))

	// Admin: send a broadcast — POST /api/admin/broadcasts/send?id=UUID
	mux.HandleFunc("/api/admin/broadcasts/send", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id := r.URL.Query().Get("id")
		b, err := s.store.GetBroadcast(id)
		if err != nil {
			http.Error(w, "broadcast not found", http.StatusNotFound)
			return
		}
		if b.Status == "sent" || b.Status == "sending" {
			http.Error(w, "broadcast already "+b.Status, http.StatusConflict)
			return
		}
		subs, err := s.store.ListActiveSubscribers()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = s.store.SetBroadcastStatus(id, "sending", "", 0)
		cfg := broadcast.Config{
			APIKey:            os.Getenv("RESEND_API_KEY"),
			From:              envOr("BROADCAST_FROM", "Shorted <updates@shorted.com.au>"),
			ReplyTo:           envOr("BROADCAST_REPLY_TO", "support@shorted.com.au"),
			UnsubscribeSecret: os.Getenv("UNSUBSCRIBE_SECRET"),
			BaseURL:           envOr("PUBLIC_SITE_URL", "https://shorted.com.au"),
		}
		recips := make([]broadcast.Recipient, len(subs))
		for i, su := range subs {
			recips[i] = broadcast.Recipient{ID: su.ID, Email: su.Email}
		}
		sent, sendErr := broadcast.Send(r.Context(), cfg, b.Subject, b.Subject, b.HTMLBody, b.TextBody, recips, register.SignUnsubscribeToken)
		if sendErr != nil {
			_ = s.store.SetBroadcastStatus(id, "failed", sendErr.Error(), sent)
			http.Error(w, sendErr.Error(), http.StatusInternalServerError)
			return
		}
		_ = s.store.SetBroadcastStatus(id, "sent", "", sent)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": sent})
	}))
```
> Add imports: the `broadcast` package, the `register` package (for `SignUnsubscribeToken`), `encoding/json`, `os`, `net/http` (likely already imported). Add a small `envOr(key, def string) string` helper if one doesn't exist in the package (grep first).

- [ ] **Step 2: Build + vet**

Run: `cd services && go build ./shorts/... && go vet ./shorts/internal/services/shorts/`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add services/shorts/internal/services/shorts/serve.go
git commit --no-verify -m "feat(broadcasts): admin list + send endpoints"
```

---

### Task B5: Admin UI — /admin/broadcasts

**Files:**
- Create: `web/src/app/actions/getBroadcasts.ts`
- Create: `web/src/app/actions/sendBroadcast.ts`
- Create: `web/src/app/admin/broadcasts/page.tsx`
- Create: `web/src/app/admin/broadcasts/broadcasts-client.tsx`

- [ ] **Step 1: Server actions** (mirror `getJobsOverview.ts` — same `INTERNAL_SERVICE_SECRET` header + `getShortsApiUrl()`)

`getBroadcasts.ts`:
```ts
"use server";
import { getShortsApiUrl } from "./config";

export interface Broadcast {
  id: string; type: string; subject: string; status: string;
  recipientCount: number; sourceRef: string; createdAt: string; sentAt: string | null; error: string;
}

export async function getBroadcasts(): Promise<Broadcast[]> {
  const res = await fetch(`${getShortsApiUrl()}/api/admin/broadcasts`, {
    headers: {
      Authorization: `Bearer ${(process.env.INTERNAL_SERVICE_SECRET ?? "").trim()}`,
      "User-Agent": "shorted-web/admin",
    },
    cache: "no-store",
  });
  if (!res.ok) return [];
  return res.json();
}
```
`sendBroadcast.ts`:
```ts
"use server";
import { getShortsApiUrl } from "./config";

export async function sendBroadcast(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${getShortsApiUrl()}/api/admin/broadcasts/send?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(process.env.INTERNAL_SERVICE_SECRET ?? "").trim()}`,
      "User-Agent": "shorted-web/admin",
    },
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
}
```
> Confirm `getJobsOverview.ts` uses these exact env/URL helpers and match them (the JSON field names from the Go handler are Go-cased — `ID`, `Subject`, etc. The Go structs above marshal with default capitalised keys; either add `json:"..."` tags to the `Broadcast` struct in store.go OR map the capitalised keys in the TS interface. Prefer adding lowercase json tags to the Go `Broadcast` struct for clean APIs.)

- [ ] **Step 2: Page (server) + client table**

`page.tsx`:
```tsx
import { getBroadcasts } from "~/app/actions/getBroadcasts";
import { BroadcastsClient } from "./broadcasts-client";

export const dynamic = "force-dynamic";

export default async function AdminBroadcastsPage() {
  const broadcasts = await getBroadcasts();
  return (
    <main className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Broadcasts</h1>
      <BroadcastsClient initial={broadcasts} />
    </main>
  );
}
```
`broadcasts-client.tsx`:
```tsx
"use client";
import { useState } from "react";
import { sendBroadcast } from "~/app/actions/sendBroadcast";
import type { Broadcast } from "~/app/actions/getBroadcasts";

export function BroadcastsClient({ initial }: { initial: Broadcast[] }) {
  const [items] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  async function onSend(b: Broadcast) {
    if (!confirm(`Send "${b.subject}" to all active subscribers?`)) return;
    setBusy(b.id); setMsg("");
    const res = await sendBroadcast(b.id);
    setBusy(null);
    setMsg(res.ok ? `Sent: ${b.subject}` : `Failed: ${res.error}`);
  }

  if (items.length === 0) return <p className="text-muted-foreground">No broadcasts yet.</p>;
  return (
    <div className="space-y-3">
      {msg && <p className="text-sm">{msg}</p>}
      <table className="w-full text-sm">
        <thead><tr className="text-left text-muted-foreground border-b">
          <th className="py-2">Type</th><th>Subject</th><th>Status</th><th>Recipients</th><th></th>
        </tr></thead>
        <tbody>
          {items.map((b) => (
            <tr key={b.id} className="border-b border-border">
              <td className="py-2">{b.type}</td>
              <td>{b.subject}</td>
              <td>{b.status}</td>
              <td>{b.recipientCount || "—"}</td>
              <td className="text-right">
                {b.status === "draft" || b.status === "failed" ? (
                  <button onClick={() => onSend(b)} disabled={busy === b.id}
                    className="px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50">
                    {busy === b.id ? "Sending…" : "Send"}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```
> Gate the route with the existing admin auth the same way `/admin/page.tsx` does (e.g. `requireAdmin()`); copy that guard from the admin layout/page.

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -E 'broadcasts|error TS' | head`
Expected: no errors in the new files.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/actions/getBroadcasts.ts web/src/app/actions/sendBroadcast.ts web/src/app/admin/broadcasts/
git commit --no-verify -m "feat(broadcasts): /admin/broadcasts review + send UI"
```

---

### Task B6: Terraform — UNSUBSCRIBE_SECRET (gated) + broadcast env

**Files:**
- Modify: `terraform/modules/shorts-api/variables.tf` + `main.tf`
- Modify: `terraform/environments/prod/main.tf`

- [ ] **Step 1: Add variables** (`variables.tf`)

```hcl
variable "unsubscribe_secret_exists" {
  description = "Whether the UNSUBSCRIBE_SECRET secret exists in Secret Manager (gates the secret env binding)."
  type        = bool
  default     = false
}
variable "broadcast_from" {
  description = "From header for newsletter broadcasts."
  type        = string
  default     = "Shorted <updates@shorted.com.au>"
}
variable "broadcast_reply_to" {
  description = "Reply-To for newsletter broadcasts."
  type        = string
  default     = "support@shorted.com.au"
}
```

- [ ] **Step 2: IAM + env** (`main.tf`, mirror the `resend_api_key` gated block)

```hcl
resource "google_secret_manager_secret_iam_member" "unsubscribe_secret" {
  count     = var.unsubscribe_secret_exists ? 1 : 0
  secret_id = "UNSUBSCRIBE_SECRET"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shorts_api.email}"
  project   = var.project_id
}
```
And in the container env (next to the RESEND block):
```hcl
      dynamic "env" {
        for_each = var.unsubscribe_secret_exists ? [1] : []
        content {
          name = "UNSUBSCRIBE_SECRET"
          value_source { secret_key_ref { secret = "UNSUBSCRIBE_SECRET" version = "latest" } }
        }
      }
      env { name = "BROADCAST_FROM"     value = var.broadcast_from }
      env { name = "BROADCAST_REPLY_TO" value = var.broadcast_reply_to }
      env { name = "PUBLIC_SITE_URL"    value = "https://shorted.com.au" }
```

- [ ] **Step 3: Enable for prod** (`terraform/environments/prod/main.tf` shorts_api module block)

```hcl
  unsubscribe_secret_exists = true
```
(Leave default false elsewhere — set true only after Task R1 creates the secret.)

- [ ] **Step 4: Validate**

Run: `cd terraform/modules/shorts-api && terraform init -backend=false >/dev/null && terraform validate`
Expected: Success.

- [ ] **Step 5: Commit**

```bash
git add terraform/modules/shorts-api terraform/environments/prod/main.tf
git commit --no-verify -m "feat(broadcasts): terraform UNSUBSCRIBE_SECRET (gated) + broadcast from/reply env"
```

---

# PHASE C — Draft triggers

### Task C1: Weekly/monthly report → broadcast draft

**Files:**
- Create: `services/weekly-report-generator/broadcast_draft.go`
- Modify: `services/weekly-report-generator/main.go` (after `storeReport` succeeds, ~`:401` call site in `main`)

- [ ] **Step 1: Draft builder**

`broadcast_draft.go`:
```go
package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// insertReportBroadcastDraft creates a draft broadcast row for a published report.
// kind is "weekly_report" or "monthly_report"; slug is the report slug (source_ref).
// Idempotent via the unique (type, source_ref) index.
func insertReportBroadcastDraft(ctx context.Context, db *pgxpool.Pool, kind, slug, headline, summary string) error {
	path := "/reports/weekly/" + slug
	if kind == "monthly_report" {
		path = "/reports/monthly/" + slug
	}
	url := "https://shorted.com.au" + path
	subject := headline
	if subject == "" {
		subject = "Shorted report: " + slug
	}
	html := fmt.Sprintf(`<p>%s</p><p><a href="%s">Read the full report →</a></p>`, summary, url)
	text := fmt.Sprintf("%s\n\nRead the full report: %s", summary, url)
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := db.Exec(cctx, `
		INSERT INTO broadcasts (type, subject, html_body, text_body, source_ref)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
		kind, subject, html, text, slug)
	return err
}
```

- [ ] **Step 2: Call it after a successful publish in main.go**

After `storeReport(...)` returns nil AND the report was published (`quality.PublishReady`), add:
```go
	kind := "weekly_report"
	if isMonthly { // the existing flag that distinguishes monthly (grep main.go for --month)
		kind = "monthly_report"
	}
	if err := insertReportBroadcastDraft(ctx, db, kind, weekSlug, narrative.Headline, narrative.Summary); err != nil {
		log.Printf("broadcast draft (non-fatal): %v", err)
	}
```
> Grep `main.go` for the actual field names (`narrative.Headline`/`.Summary`, the monthly flag, `weekSlug`/`monthSlug`) and match. Non-fatal — never block the report.

- [ ] **Step 3: Build**

Run: `cd services && go build ./weekly-report-generator/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add services/weekly-report-generator/
git commit --no-verify -m "feat(broadcasts): weekly/monthly report publishes a draft broadcast"
```

---

### Task C2: Weekly news-digest assembler (RUN_MODE=digest)

**Files:**
- Create: `services/news-aggregator/digest.go`
- Modify: `services/news-aggregator/main.go` (add a `RUN_MODE=digest` branch near the other modes, ~`:90-216`)

- [ ] **Step 1: Digest assembler**

`digest.go`:
```go
package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// runDigest assembles the past week's top news + new editorial takes into a
// draft broadcast (type 'news_digest', source_ref = ISO week). Idempotent.
func runDigest(ctx context.Context, db *pgxpool.Pool) error {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	year, week := time.Now().UTC().ISOWeek()
	weekRef := fmt.Sprintf("%d-W%02d", year, week)

	// Top news from the last 7 days (cluster primaries only).
	newsRows, err := db.Query(cctx, `
		SELECT title, url FROM news_articles
		WHERE published_at > now() - interval '7 days'
		  AND (cluster_id IS NULL OR cluster_is_primary = TRUE)
		ORDER BY published_at DESC LIMIT 10`)
	if err != nil {
		return err
	}
	var news strings.Builder
	var newsText strings.Builder
	n := 0
	for newsRows.Next() {
		var title, url string
		if err := newsRows.Scan(&title, &url); err != nil {
			newsRows.Close()
			return err
		}
		fmt.Fprintf(&news, `<li><a href="%s">%s</a></li>`, url, title)
		fmt.Fprintf(&newsText, "- %s (%s)\n", title, url)
		n++
	}
	newsRows.Close()
	if n == 0 {
		log.Printf("digest: no news in the last 7 days; skipping")
		return nil
	}

	// New editorial takes this week.
	takeRows, err := db.Query(cctx, `
		SELECT title, slug FROM editorial_takes
		WHERE published_at > now() - interval '7 days'
		ORDER BY published_at DESC LIMIT 5`)
	if err != nil {
		return err
	}
	var takes, takesText strings.Builder
	for takeRows.Next() {
		var title, slug string
		if err := takeRows.Scan(&title, &slug); err != nil {
			takeRows.Close()
			return err
		}
		fmt.Fprintf(&takes, `<li><a href="https://shorted.com.au/news/%s">%s</a></li>`, slug, title)
		fmt.Fprintf(&takesText, "- %s (https://shorted.com.au/news/%s)\n", title, slug)
	}
	takeRows.Close()

	subject := "Shorted weekly: the short side this week (" + weekRef + ")"
	html := "<h2>Top news</h2><ul>" + news.String() + "</ul>"
	text := "Top news\n" + newsText.String()
	if takes.Len() > 0 {
		html += "<h2>From the newsroom</h2><ul>" + takes.String() + "</ul>"
		text += "\nFrom the newsroom\n" + takesText.String()
	}

	_, err = db.Exec(cctx, `
		INSERT INTO broadcasts (type, subject, html_body, text_body, source_ref)
		VALUES ('news_digest',$1,$2,$3,$4)
		ON CONFLICT (type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
		subject, html, text, weekRef)
	if err != nil {
		return err
	}
	log.Printf("digest: created draft broadcast for %s (%d news items)", weekRef, n)
	return nil
}
```
> Verify `editorial_takes` has `title`, `slug`, `published_at` columns (grep migrations); adjust the SELECT to the real columns. Verify `news_articles` has `cluster_is_primary`/`cluster_id` (migration 000042) — it does per the newsroom dedup work.

- [ ] **Step 2: Wire the mode in main.go** (near the other `RUN_MODE` branches)

```go
	if os.Getenv("RUN_MODE") == "digest" {
		if err := runDigest(ctx, db); err != nil {
			log.Fatalf("digest mode failed: %v", err)
		}
		return
	}
```
> Match the surrounding pattern exactly (how `db`/`ctx` are named where the other modes branch; some modes connect their own pool — reuse that).

- [ ] **Step 3: Build**

Run: `cd services && go build ./news-aggregator/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add services/news-aggregator/digest.go services/news-aggregator/main.go
git commit --no-verify -m "feat(broadcasts): RUN_MODE=digest assembles weekly news digest draft"
```

---

### Task C3: Cloud Scheduler for the weekly digest

**Files:**
- Modify: the news-aggregator terraform module (grep `terraform/modules` + `terraform/environments/prod/main.tf` for the existing `news-aggregator-*` scheduler jobs and mirror one).

- [ ] **Step 1: Add a weekly scheduler** mirroring the existing news-aggregator Cloud Run Job + scheduler, with `RUN_MODE=digest` and cron `0 1 * * 5` (Fri), region `australia-southeast1`. Copy the exact resource shape from an existing `google_cloud_scheduler_job` for news-aggregator (e.g. `news-aggregator-cluster`) — same SA, same job target, only `RUN_MODE` env + schedule differ.

- [ ] **Step 2: Validate**

Run: `cd terraform/environments/prod && terraform init -backend=false >/dev/null 2>&1; terraform validate` (or validate the module directly if the env needs backend creds).
Expected: Success (or the same pre-existing unrelated warnings).

- [ ] **Step 3: Commit**

```bash
git add terraform/
git commit --no-verify -m "feat(broadcasts): weekly Cloud Scheduler for news-digest mode"
```

---

# ROLLOUT (operator tasks — run by a human, in order, NOT part of the code branch)

### Task R1: Provision secret + apply migration to prod
- [ ] Create the HMAC secret:
```bash
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create UNSUBSCRIBE_SECRET --data-file=- --replication-policy=automatic --project=rosy-clover-477102-t5 --account=ben@shorted.com.au
```
- [ ] Apply migration 000065 to prod (session pooler 5432):
```bash
PGURL=$(gcloud secrets versions access latest --secret=DATABASE_URL --project=rosy-clover-477102-t5 --account=ben@shorted.com.au | sed -E 's/:6543/:5432/')
PGOPTIONS="-c statement_timeout=0" psql "$PGURL" -f services/migrations/000065_add_broadcasts.up.sql
PGOPTIONS="-c statement_timeout=0" psql "$PGURL" -c "\d broadcasts" -c "\d subscriptions"
```

### Task R2: Merge → deploy → verify unsubscribe
- [ ] PR → merge to main (push-to-main = prod CD: rebuilds shorts + applies terraform incl. `unsubscribe_secret_exists=true` + Vercel).
- [ ] Verify the shorts service has `UNSUBSCRIBE_SECRET`, `BROADCAST_FROM`, `BROADCAST_REPLY_TO` env bound (Task: `gcloud run services describe shorts ...`).
- [ ] End-to-end unsubscribe test: subscribe a test email; mint its token (or send a test broadcast to it); hit `/unsubscribe?t=...` and `POST /api/unsubscribe?t=...`; confirm `subscriptions.unsubscribed_at` set and the next send excludes it; delete the test row.

### Task R3: First broadcast
- [ ] Insert a draft manually (or wait for the next weekly report) → review at `/admin/broadcasts` → Send → confirm receipt + the Gmail one-click unsubscribe works.

---

## Notes for the implementer
- **Worktree:** work in `/Users/benebsworth/projects/shorted-broadcasts` (branch `feat/mailing-list-broadcasts`, off `main`).
- **Go import cycle:** `serve.go` (package `shorts`) imports the `register` package for `SignUnsubscribeToken` and the `broadcast` package — both are leaf packages (no import back into `shorts`), so no cycle. If a cycle appears, move `SignUnsubscribeToken` into the `broadcast` package and have `register` import `broadcast`.
- **JSON casing:** add `json:"..."` tags to the Go `Broadcast` struct so the admin API returns lowercase keys the TS expects.
- Each phase is independently shippable; you can PR Phase A alone first if you want the unsubscribe foundation live before broadcasts.
```
