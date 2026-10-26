package alerts

// The end-to-end suite drives run() against a real Postgres and two HTTP stubs: a
// Resend stub that records and dedupes like Resend, and the shorts API's
// BillingService. It needs ALERTS_TEST_DATABASE_URL and skips without it. The
// Makefile target test-alerts-e2e starts a throwaway postgres:15 container for it.
//
// Every test builds its own schema from the real 000074 and 000147 migrations, so
// the migration files are exercised as they will run in prod.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

const (
	e2eResendKey  = "test-resend-key"
	e2eUnsubKey   = "test-unsubscribe-secret-e2e"
	canaryAddress = "delivered@resend.dev"
	u1Email       = "owner-one@example.com"
	u2Email       = "owner-two@example.com"
)

// ---- Resend stub -----------------------------------------------------------

// resendReq is one POST /emails the stub received.
type resendReq struct {
	key      string
	to       string
	subject  string
	from     string
	headers  map[string]string
	tags     []map[string]string
	raw      []byte
	status   int
	resendID string
}

// resendStub accepts emails the way Resend does for these purposes: an accepted
// email gets an id, and a repeat of an accepted Idempotency-Key with the same body
// returns that id without sending again. A repeat with a different body is a 409.
type resendStub struct {
	srv *httptest.Server

	mu       sync.Mutex
	requests []resendReq
	accepted map[string]int    // key -> deliveries Resend would make
	bodies   map[string][]byte // key -> the first accepted body
	ids      map[string]string
	nextID   int
	fail     map[string]int           // recipient -> remaining 500 answers
	reject   map[string]stubRejection // recipient -> the answer every time
}

// stubRejection is a fixed error answer: an HTTP status and Resend's error name.
type stubRejection struct {
	status int
	name   string
}

func newResendStub(t *testing.T) *resendStub {
	t.Helper()
	s := &resendStub{
		accepted: map[string]int{},
		bodies:   map[string][]byte{},
		ids:      map[string]string{},
		fail:     map[string]int{},
		reject:   map[string]stubRejection{},
	}
	s.srv = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *resendStub) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	var body struct {
		From    string              `json:"from"`
		To      []string            `json:"to"`
		Subject string              `json:"subject"`
		Headers map[string]string   `json:"headers"`
		Tags    []map[string]string `json:"tags"`
	}
	_ = json.Unmarshal(raw, &body)
	to := ""
	if len(body.To) > 0 {
		to = body.To[0]
	}
	key := r.Header.Get("Idempotency-Key")
	rec := resendReq{key: key, to: to, subject: body.Subject, from: body.From, headers: body.Headers, tags: body.Tags, raw: raw}
	defer func() { s.requests = append(s.requests, rec) }()

	if r.Header.Get("Authorization") != "Bearer "+e2eResendKey {
		rec.status = http.StatusUnauthorized
		writeStub(w, rec.status, `{"name":"missing_api_key"}`)
		return
	}
	if key == "" {
		rec.status = http.StatusBadRequest
		writeStub(w, rec.status, `{"name":"validation_error"}`)
		return
	}
	if rj, ok := s.reject[to]; ok {
		rec.status = rj.status
		writeStub(w, rj.status, fmt.Sprintf(`{"name":%q}`, rj.name))
		return
	}
	if s.fail[to] > 0 {
		s.fail[to]--
		rec.status = http.StatusInternalServerError
		writeStub(w, rec.status, `{"name":"application_error"}`)
		return
	}
	if first, ok := s.bodies[key]; ok {
		if string(first) != string(raw) {
			rec.status = http.StatusConflict
			writeStub(w, rec.status, `{"name":"invalid_idempotent_request"}`)
			return
		}
		rec.status = http.StatusOK
		rec.resendID = s.ids[key]
		writeStub(w, rec.status, fmt.Sprintf(`{"id":%q}`, s.ids[key]))
		return
	}
	s.nextID++
	id := fmt.Sprintf("re_%04d", s.nextID)
	s.bodies[key] = raw
	s.ids[key] = id
	s.accepted[key]++
	rec.status = http.StatusOK
	rec.resendID = id
	writeStub(w, rec.status, fmt.Sprintf(`{"id":%q}`, id))
}

func writeStub(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// snapshot returns a copy of the requests received so far.
func (s *resendStub) snapshot() []resendReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]resendReq(nil), s.requests...)
}

func (s *resendStub) count() int { return len(s.snapshot()) }

// acceptedFor is how many deliveries Resend would have made for a key.
func (s *resendStub) acceptedFor(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accepted[key]
}

func (s *resendStub) setFail(to string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fail[to] = n
}

func (s *resendStub) setReject(to string, status int, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reject[to] = stubRejection{status: status, name: name}
}

// ---- fixture ---------------------------------------------------------------

type e2e struct {
	t       *testing.T
	ctx     context.Context
	pool    *pgxpool.Pool
	resend  *resendStub
	billing *stubBilling
	billURL string
}

// newE2E builds a fresh schema, applies the migrations, starts both stubs and
// points the environment at them.
func newE2E(t *testing.T) *e2e {
	t.Helper()
	base, err := testpostgres.Admin("ALERTS_TEST_DATABASE_URL", "ALERTS_E2E_TESTCONTAINERS")
	if err != nil {
		t.Fatalf("start the alerts PostgreSQL container: %v", err)
	}
	if base == "" {
		t.Skip("neither ALERTS_TEST_DATABASE_URL nor ALERTS_E2E_TESTCONTAINERS=1 is set; the alerts end-to-end suite runs in CI and under make test-alerts-e2e")
	}
	refuseSharedDSN(t, base)
	ctx := context.Background()

	var raw [6]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	schema := "alerts_e2e_" + hex.EncodeToString(raw[:])

	admin, err := pgxpool.New(ctx, base)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(admin.Close)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
			t.Logf("drop schema: %v", err)
		}
	})

	dsn := withSearchPath(t, base, schema)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect to schema: %v", err)
	}
	t.Cleanup(pool.Close)

	mustExec(t, pool, baseSchema)
	applyMigration(t, pool, "000074_*.up.sql")
	applyMigration(t, pool, "000147_*.up.sql")
	// 000147 must replay cleanly: prod re-runs the allowlist on every deploy.
	applyMigration(t, pool, "000147_*.up.sql")
	applyMigration(t, pool, "000148_*.up.sql")
	// 000148 must replay cleanly too, and a replay must keep the suppression table.
	applyMigration(t, pool, "000148_*.up.sql")

	rs := newResendStub(t)
	billing := newStubBilling()
	billURL := startShortsAPI(t, billing, e2eUnsubKey)

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("RESEND_API_KEY", e2eResendKey)
	t.Setenv("RESEND_API_URL", rs.srv.URL)
	t.Setenv("PUBLIC_SITE_URL", "https://shorted.com.au")
	t.Setenv("UNSUBSCRIBE_SECRET", e2eUnsubKey)
	t.Setenv("SHORTS_API_URL", billURL)
	t.Setenv("INTERNAL_SERVICE_SECRET", stubSecret)
	t.Setenv("ALERTS_RESEND_RPS", "1000")
	t.Setenv("ALERTS_DRY_RUN", "false")
	t.Setenv("CLOUD_RUN_EXECUTION", "alerts-e2e-"+schema)

	return &e2e{t: t, ctx: ctx, pool: pool, resend: rs, billing: billing, billURL: billURL}
}

// refuseSharedDSN keeps the suite off the production pooler and Supabase. It is
// a throwaway database by design, and the tests delete their schemas.
func refuseSharedDSN(t *testing.T, dsn string) {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse ALERTS_TEST_DATABASE_URL: %v", err)
	}
	host := strings.ToLower(u.Host)
	if strings.Contains(host, "supabase") || strings.Contains(host, "pooler") || strings.HasSuffix(host, ":6543") {
		t.Fatal("refusing to run the alerts suite against a pooler or Supabase database")
	}
}

// withSearchPath points a copy of the DSN at the test schema.
func withSearchPath(t *testing.T, base, schema string) string {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	return u.String()
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec %.60q: %v", sql, err)
	}
}

// applyMigration runs one real migration file from services/migrations.
func applyMigration(t *testing.T, pool *pgxpool.Pool, glob string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join("..", "..", "..", "..", "migrations", glob))
	if err != nil || len(matches) != 1 {
		t.Fatalf("migration %s: %v (%d matches)", glob, err, len(matches))
	}
	raw, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, string(raw))
}

// baseSchema is the minimum the evaluator reads from tables that other migrations own.
const baseSchema = `
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TABLE shorts (
  "DATE" timestamp NOT NULL,
  "PRODUCT_CODE" text NOT NULL,
  "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" double precision,
  "REPORTED_SHORT_POSITIONS" double precision,
  "TOTAL_PRODUCT_IN_ISSUE" double precision,
  PRIMARY KEY ("DATE", "PRODUCT_CODE")
);
CREATE TABLE "company-metadata" (
  stock_code text PRIMARY KEY,
  company_name text,
  industry text,
  logo_icon_gcs_url text,
  logo_gcs_url text
);
CREATE TABLE sync_status (
  id serial PRIMARY KEY,
  run_id uuid,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  environment text,
  hostname text
);`

// day inserts one report: the codes and their readings for a date.
func (e *e2e) day(date string, rows map[string]float64) {
	e.t.Helper()
	for code, pct := range rows {
		mustExec(e.t, e.pool, `INSERT INTO shorts ("DATE", "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") VALUES ($1::date, $2, $3)`, date, code, pct)
	}
}

// syncRow records one sync_status row, started ago before now. An "asic" row is written
// the way shortdatasync's recorder writes it, with environment and hostname set. A
// "price" row is written the way the market-data sync's checkpoint writes it, with
// neither. The alerts gate reads only the asic rows.
func (e *e2e) syncRow(writer, status, ago string) {
	e.t.Helper()
	var env, host any
	if writer == "asic" {
		env, host = "production", "shorts-data-sync-exec"
	}
	mustExec(e.t, e.pool, `INSERT INTO sync_status (status, started_at, environment, hostname) VALUES ($1, now() - $2::interval, $3, $4)`,
		status, ago, env, host)
}

// company registers a code's name and industry.
func (e *e2e) company(code, name, industry string) {
	e.t.Helper()
	mustExec(e.t, e.pool, `INSERT INTO "company-metadata" (stock_code, company_name, industry) VALUES ($1, $2, $3)`, code, name, industry)
}

// monitor inserts an alert monitor. Pass a non-empty status to override "active".
func (e *e2e) monitor(id, userID, email, scope, target, condition, cadence string, threshold *float64, status string) {
	e.t.Helper()
	if status == "" {
		status = "active"
	}
	mustExec(e.t, e.pool, `
		INSERT INTO alert_monitors (id, user_id, user_email, scope, target, condition, threshold, cadence, status)
		VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9)`,
		id, userID, email, scope, target, condition, threshold, cadence, status)
}

// run invokes the job exactly as the CronJob does, with the given flags, and returns
// the exit code it would give.
func (e *e2e) run(args ...string) int {
	e.t.Helper()
	err := run(e.ctx, args, runner.Globals{}, io.Discard, os.Getenv)
	if err == nil {
		return 0
	}
	return runner.ExitCodeOf(err)
}

// seedBase registers the company metadata the Materials fixture needs.
func (e *e2e) seedBase() {
	e.company("AAA", "Aaa Resources Ltd", "Materials")
	e.company("BBB", "Bbb Metals Ltd", "Materials")
	e.company("CCC", "Ccc Lithium Ltd", "Materials")
	e.company("EEE", "Eee Minerals Ltd", "Materials")
	for i := 1; i <= 8; i++ {
		e.company(fmt.Sprintf("F%d", i), fmt.Sprintf("Filler %d Ltd", i), "Materials")
	}
	e.company("DDD", "Ddd Power Ltd", "Energy")
}

// materialsDay is the fixture: the spec's codes, plus eight fillers so the industry
// has more than ten companies. aaa, eee and ccc override the defaults for the day.
func materialsDay(aaa, eee, ccc float64) map[string]float64 {
	rows := map[string]float64{
		"AAA": aaa, "BBB": 6.50, "CCC": ccc, "EEE": eee, "DDD": 5.00,
	}
	for i := 1; i <= 8; i++ {
		rows[fmt.Sprintf("F%d", i)] = 4.5 - 0.1*float64(i)
	}
	return rows
}

// baseDay0 is the bootstrap day: AAA 4.80, BBB 6.00, EEE 4.99, no CCC yet.
func baseDay0() map[string]float64 {
	rows := materialsDay(4.80, 4.99, 0)
	delete(rows, "CCC")
	rows["BBB"] = 6.00
	return rows
}

// requestsTo returns the requests addressed to one recipient.
func requestsTo(reqs []resendReq, to string) []resendReq {
	var out []resendReq
	for _, r := range reqs {
		if r.to == to {
			out = append(out, r)
		}
	}
	return out
}

// ---- assertions ------------------------------------------------------------

type evRow struct {
	id         int64
	monitorID  string
	status     string
	attempts   int
	lastError  string
	resendID   string
	reportDate string
	comparedTo string
	payload    alertevents.Payload
	createdAt  time.Time
}

func (e *e2e) events(where string, args ...any) []evRow {
	e.t.Helper()
	rows, err := e.pool.Query(e.ctx, `
		SELECT id, monitor_id, email_status, email_attempts, COALESCE(last_error, ''), COALESCE(resend_id, ''),
		       report_date::text, compared_to_date::text, payload, created_at
		  FROM alert_events `+where+` ORDER BY id`, args...)
	if err != nil {
		e.t.Fatalf("query events: %v", err)
	}
	defer rows.Close()
	var out []evRow
	for rows.Next() {
		var (
			r       evRow
			payload []byte
		)
		if err := rows.Scan(&r.id, &r.monitorID, &r.status, &r.attempts, &r.lastError, &r.resendID, &r.reportDate, &r.comparedTo, &payload, &r.createdAt); err != nil {
			e.t.Fatal(err)
		}
		if err := json.Unmarshal(payload, &r.payload); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func (e *e2e) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(e.ctx, sql, args...).Scan(&n); err != nil {
		e.t.Fatalf("count %.50q: %v", sql, err)
	}
	return n
}

func (e *e2e) watermarks() (daily, weekly string) {
	e.t.Helper()
	if err := e.pool.QueryRow(e.ctx, `SELECT COALESCE(daily_through::text,''), COALESCE(weekly_through::text,'') FROM alert_evaluator_state WHERE id = 1`).Scan(&daily, &weekly); err != nil {
		e.t.Fatal(err)
	}
	return daily, weekly
}

func (e *e2e) wantExit(got, want int, why string) {
	e.t.Helper()
	if got != want {
		e.t.Fatalf("%s: exit %d, want %d", why, got, want)
	}
}

func (e *e2e) wantStatus(id int64, status string) {
	e.t.Helper()
	var got string
	if err := e.pool.QueryRow(e.ctx, `SELECT email_status FROM alert_events WHERE id = $1`, id).Scan(&got); err != nil {
		e.t.Fatal(err)
	}
	if got != status {
		e.t.Fatalf("event %d status = %s, want %s", id, got, status)
	}
}

// ---- the suite -------------------------------------------------------------

// TestAlertsE2ELifecycle covers the spec's cases 1 to 5: bootstrap, the first real
// evaluation with every combination, idempotent re-run, a send that was stuck in
// sending, and a retryable failure that recovers.
func TestAlertsE2ELifecycle(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.billing.setStatus("u2", "SUBSCRIPTION_STATUS_CANCELED")

	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.monitor("m2", "u1", u1Email, "stock", "BBB", "short_interest_rises", "daily", new(0.5), "")
	e.monitor("m3", "u1", u1Email, "industry", "Materials", "short_interest_above", "daily", new(float64(5)), "")
	e.monitor("m4", "u1", u1Email, "industry", "Materials", "short_interest_rises", "daily", new(0.4), "")
	e.monitor("m5", "u1", u1Email, "industry", "Materials", "new_top_ten_entry", "daily", nil, "")
	e.monitor("m6", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "paused")
	e.monitor("m7", "u1", u1Email, "stock", "AAA", "short_interest_above", "weekly", new(float64(5)), "")
	e.monitor("m8", "u2", u2Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.monitor("m9", "u3", "", "stock", "BBB", "short_interest_rises", "daily", new(0.5), "")

	// Case 1: the bootstrap evaluates nothing, sends exactly one canary, and sets
	// the watermark to the newest report.
	// CCC has an earlier reading below the top ten, so it has two readings and can
	// enter the top ten on 14 Oct. A code with a single reading never fires.
	bootstrap := baseDay0()
	bootstrap["CCC"] = 0.10
	e.day("2026-10-13", bootstrap)
	e.wantExit(e.run(), 0, "bootstrap")
	if d, _ := e.watermarks(); d != "2026-10-13" {
		t.Fatalf("bootstrap daily watermark = %s", d)
	}
	if got := e.count(`SELECT count(*) FROM alert_events`); got != 0 {
		t.Fatalf("bootstrap wrote %d events", got)
	}
	reqs := e.resend.snapshot()
	if len(reqs) != 1 || reqs[0].to != canaryAddress || !strings.HasPrefix(reqs[0].key, "alert-canary-") {
		t.Fatalf("bootstrap must send exactly one canary, got %+v", reqs)
	}

	// Case 2: the first real evaluation. Every combination fires as the spec says.
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	e.wantExit(e.run(), 0, "first evaluation")

	byMonitor := map[string]evRow{}
	for _, ev := range e.events(`WHERE report_date = '2026-10-14'`) {
		byMonitor[ev.monitorID] = ev
	}
	for _, id := range []string{"m1", "m2", "m3", "m4", "m5"} {
		ev, ok := byMonitor[id]
		if !ok {
			t.Fatalf("%s did not fire on 14 Oct", id)
		}
		if ev.status != "sent" || ev.resendID == "" {
			t.Fatalf("%s = %s resend=%q, want sent with an id", id, ev.status, ev.resendID)
		}
		if ev.comparedTo != "2026-10-13" {
			t.Fatalf("%s compared_to = %s", id, ev.comparedTo)
		}
	}
	if _, ok := byMonitor["m6"]; ok {
		t.Fatal("the paused monitor must not fire")
	}
	if _, ok := byMonitor["m7"]; ok {
		t.Fatal("a weekly monitor must not fire on a daily evaluation")
	}
	// CCC crosses 5% and rises on 14 Oct, and every company in the industry is checked.
	if got := codesIn(byMonitor["m3"].payload); got != "CCC,AAA,EEE" {
		t.Fatalf("industry above crossers = %s, want CCC,AAA,EEE (by latest reading)", got)
	}
	if got := codesIn(byMonitor["m4"].payload); got != "CCC,BBB,AAA" {
		t.Fatalf("industry rises = %s, want CCC,BBB,AAA (by change)", got)
	}
	if got := codesIn(byMonitor["m5"].payload); got != "CCC" {
		t.Fatalf("top ten entrants = %s, want CCC", got)
	}
	if ev := byMonitor["m8"]; ev.status != "skipped_unentitled" || ev.lastError != "entitlement: status=CANCELED" {
		t.Fatalf("the canceled owner's event = %+v", ev)
	}
	if ev := byMonitor["m9"]; ev.status != "skipped_no_email" {
		t.Fatalf("the email-less owner's event = %s", ev.status)
	}

	// The canary is the first request of this run, and the customer emails carry the
	// real headers.
	reqs = e.resend.snapshot()
	if reqs[1].to != canaryAddress {
		t.Fatalf("the canary must go out before the customer mail of the same run, got %s", reqs[1].to)
	}
	customer := requestsTo(reqs, u1Email)
	if len(customer) != 5 {
		t.Fatalf("customer emails to the entitled owner = %d, want 5", len(customer))
	}
	first := customer[0]
	if first.from != "Shorted Alerts <alerts@shorted.com.au>" {
		t.Fatalf("From = %q", first.from)
	}
	if first.headers["List-Unsubscribe-Post"] != "List-Unsubscribe=One-Click" || !strings.Contains(first.headers["List-Unsubscribe"], "/api/alerts/unsubscribe?t=") {
		t.Fatalf("List-Unsubscribe headers = %v", first.headers)
	}
	if first.subject != "AAA short interest crossed 5% (now 5.20%)" {
		t.Fatalf("subject = %q", first.subject)
	}
	if !strings.HasPrefix(first.key, "alert-event-") {
		t.Fatalf("idempotency key = %q", first.key)
	}

	// Case 3: a re-run finds nothing new and sends nothing.
	before := e.resend.count()
	e.wantExit(e.run(), 0, "re-run")
	if after := e.resend.count(); after != before {
		t.Fatalf("a re-run made %d stub requests", after-before)
	}

	// Case 4: a send stuck in sending for 45 minutes is re-sent under its own key
	// and delivered once. The stub already accepted it, so the key dedupes.
	m1Event := e.events(`WHERE monitor_id = 'm1' AND report_date = '2026-10-14'`)[0]
	mustExec(t, e.pool, `UPDATE alert_events SET email_status = 'sending', send_claimed_at = now() - interval '45 minutes', sent_at = NULL, resend_id = NULL WHERE id = $1`, m1Event.id)
	e.wantExit(e.run(), 0, "stuck send")
	key := idempotencyKey("event", m1Event.id, m1Event.createdAt)
	if got := e.resend.acceptedFor(key); got != 1 {
		t.Fatalf("a retried send was delivered %d times", got)
	}
	// The count above is 1 from the first send whether or not the retry reused
	// the key, so also check that the retry sent no second key for this event.
	// A requeue that touched created_at would mail the customer twice.
	prefix := fmt.Sprintf("alert-event-%d-", m1Event.id)
	for _, r := range e.resend.snapshot() {
		if strings.HasPrefix(r.key, prefix) && r.key != key {
			t.Fatalf("event %d was sent under a second key %q (first %q)", m1Event.id, r.key, key)
		}
	}
	e.wantStatus(m1Event.id, "sent")

	// Case 5: a retryable failure. The first request to the owner fails once, the
	// run exits 10 with the row pending and one attempt used, and the next run
	// delivers it. Two days are added so the crossing repeats on 16 October.
	e.day("2026-10-15", materialsDay(4.00, 5.00, 7.00))
	e.day("2026-10-16", materialsDay(5.50, 5.00, 7.00))
	e.resend.setFail(u1Email, 1)
	e.wantExit(e.run(), 10, "one retryable failure")

	retry := e.events(`WHERE report_date = '2026-10-16' AND email_status = 'pending'`)
	if len(retry) != 1 {
		t.Fatalf("pending after the failure = %d, want 1", len(retry))
	}
	if retry[0].attempts != 1 || !strings.Contains(retry[0].lastError, "status 500") {
		t.Fatalf("retry row attempts=%d last_error=%q", retry[0].attempts, retry[0].lastError)
	}
	e.wantExit(e.run(), 0, "the retry")
	e.wantStatus(retry[0].id, "sent")
}

// TestAlertsE2ECanaryRejected is case 6: a rejected canary holds customer mail.
func TestAlertsE2ECanaryRejected(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")

	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	e.resend.setReject(canaryAddress, http.StatusUnauthorized, "restricted_api_key")

	e.wantExit(e.run(), 1, "rejected canary")
	if got := len(requestsTo(e.resend.snapshot(), u1Email)); got != 0 {
		t.Fatalf("customer mail went out past a rejected canary: %d", got)
	}
	evs := e.events(`WHERE monitor_id = 'm1'`)
	if len(evs) != 1 || evs[0].status != "pending" || evs[0].attempts != 0 {
		t.Fatalf("the claim must be returned without an attempt: %+v", evs)
	}
}

// TestAlertsE2EBillingUnavailable is case 7: an unavailable entitlement lookup fails
// the run before anything is written, and the next run recovers.
func TestAlertsE2EBillingUnavailable(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")

	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))

	e.billing.setUnavailable(2)
	e.wantExit(e.run(), 1, "unavailable entitlement")
	if got := e.count(`SELECT count(*) FROM alert_events`); got != 0 {
		t.Fatalf("an entitlement failure must write no events, wrote %d", got)
	}
	if d, _ := e.watermarks(); d != "2026-10-13" {
		t.Fatalf("the watermark moved on a failed run: %s", d)
	}

	e.wantExit(e.run(), 0, "recovery")
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm1'`); got != 1 {
		t.Fatalf("the next run must evaluate, events = %d", got)
	}
}

// TestAlertsE2ESyncGate is case 8: a sync in progress defers evaluation, and a sync
// older than the two-hour window does not.
func TestAlertsE2ESyncGate(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))

	e.syncRow("asic", "running", "10 minutes")
	before := e.resend.count()
	e.wantExit(e.run(), 0, "sync in progress")
	if e.count(`SELECT count(*) FROM alert_events`) != 0 || e.resend.count() != before {
		t.Fatal("a sync in progress must write nothing and send nothing")
	}
	if d, _ := e.watermarks(); d != "2026-10-13" {
		t.Fatalf("watermark moved during a sync: %s", d)
	}

	// Three hours on, the run is no longer "in progress", but it never finished. A
	// killed sync can leave its last report part-written, so the report is held
	// rather than evaluated on partial rows.
	mustExec(t, e.pool, `UPDATE sync_status SET started_at = now() - interval '3 hours'`)
	e.wantExit(e.run(), 10, "held: the unfinished sync")
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm1'`); got != 0 {
		t.Fatalf("an unfinished sync must hold its report, events = %d", got)
	}
	if d, _ := e.watermarks(); d != "2026-10-13" {
		t.Fatalf("watermark moved past a held report: %s", d)
	}

	// A failed sync holds the same way, and a later completed sync releases it.
	e.syncRow("asic", "failed", "2 hours")
	e.wantExit(e.run(), 10, "held: the latest sync failed")
	e.syncRow("asic", "completed", "1 minute")
	e.wantExit(e.run(), 0, "a completed sync releases the hold")
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm1'`); got != 1 {
		t.Fatalf("the held report must evaluate once a sync completes, events = %d", got)
	}
}

// TestAlertsE2EPriceSweepIsNotTheASICSync: sync_status is shared with the market-data
// sync, which starts in the ASIC backstop's 10:00 UTC slot. Only the ASIC rows decide
// whether report data is settled. A price sweep that is running or has failed must
// neither hold a settled report nor release a half-written one.
func TestAlertsE2EPriceSweepIsNotTheASICSync(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.day("2026-10-13", baseDay0())
	e.syncRow("asic", "completed", "3 hours")
	e.wantExit(e.run(), 0, "bootstrap")

	// A price sweep running newer than a completed ASIC sync does not hold the report.
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	e.syncRow("price", "running", "10 seconds")
	e.wantExit(e.run(), 0, "a running price sweep does not hold a settled report")
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm1'`); got != 1 {
		t.Fatalf("a running price sweep must not block evaluation, events = %d", got)
	}

	// A failed price sweep newer than a completed ASIC sync does not hold either.
	e.day("2026-10-15", materialsDay(5.30, 5.00, 7.00))
	e.syncRow("price", "failed", "5 seconds")
	e.wantExit(e.run(), 0, "a failed price sweep does not hold a settled report")
	if d, _ := e.watermarks(); d != "2026-10-15" {
		t.Fatalf("a failed price sweep must not hold the watermark, daily_through = %s", d)
	}

	// The reverse: a newer completed price sweep does not settle a failed ASIC sync. The
	// ASIC backstop's last report is half-written, so it is held.
	e.day("2026-10-16", materialsDay(5.40, 5.00, 7.00))
	e.syncRow("asic", "failed", "4 seconds")
	e.syncRow("price", "completed", "1 second")
	e.wantExit(e.run(), 10, "held: the latest ASIC sync failed, whatever the price sweep did")
	if d, _ := e.watermarks(); d != "2026-10-15" {
		t.Fatalf("a completed price sweep must not release a held ASIC report, daily_through = %s", d)
	}
	if got := e.count(`SELECT count(*) FROM alert_events WHERE report_date = '2026-10-16'`); got != 0 {
		t.Fatalf("a held report must write no events, got %d", got)
	}
}

// TestAlertsE2ECompleteness is case 9: a half-written report holds evaluation.
func TestAlertsE2ECompleteness(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	full := func() map[string]float64 {
		rows := map[string]float64{}
		for i := range 30 {
			rows[fmt.Sprintf("X%02d", i)] = 1
		}
		return rows
	}
	e.day("2026-10-13", full())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", full())
	partial := map[string]float64{"X00": 1, "X01": 1, "X02": 1}
	e.day("2026-10-15", partial)

	e.wantExit(e.run(), 10, "held report")
	if d, _ := e.watermarks(); d != "2026-10-14" {
		t.Fatalf("the watermark must stop before the half-written day, got %s", d)
	}
}

// TestAlertsE2EWeekly is case 10: a week is evaluated only once it is complete, and
// then against the previous week's last report.
func TestAlertsE2EWeekly(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m7", "u1", u1Email, "stock", "AAA", "short_interest_above", "weekly", new(float64(5)), "")

	e.day("2026-10-09", map[string]float64{"AAA": 4.80})
	e.wantExit(e.run(), 0, "bootstrap")
	if _, w := e.watermarks(); w != "2026-10-09" {
		t.Fatalf("bootstrap weekly watermark = %s", w)
	}

	// Monday to Thursday: the week is not complete, so there is no weekly event.
	for _, d := range []string{"2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"} {
		e.day(d, map[string]float64{"AAA": 5.20})
	}
	e.wantExit(e.run(), 0, "an incomplete week")
	if got := e.count(`SELECT count(*) FROM alert_events`); got != 0 {
		t.Fatalf("an incomplete week must not produce an event, got %d", got)
	}

	// Friday's report completes the week: one weekly event against the previous Friday.
	e.day("2026-10-16", map[string]float64{"AAA": 5.20})
	e.wantExit(e.run(), 0, "the completing Friday")
	evs := e.events(`WHERE monitor_id = 'm7'`)
	if len(evs) != 1 {
		t.Fatalf("weekly events = %d, want 1", len(evs))
	}
	if evs[0].reportDate != "2026-10-16" || evs[0].comparedTo != "2026-10-09" {
		t.Fatalf("weekly event dates = %s vs %s", evs[0].reportDate, evs[0].comparedTo)
	}
}

// TestAlertsE2EUnsubscribe is case 11: the List-Unsubscribe token pauses its monitor,
// and a paused monitor does not fire on a later crossing.
func TestAlertsE2EUnsubscribe(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")

	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	e.wantExit(e.run(), 0, "first crossing")

	reqs := requestsTo(e.resend.snapshot(), u1Email)
	if len(reqs) == 0 {
		t.Fatal("no customer email captured")
	}
	header := reqs[0].headers["List-Unsubscribe"]
	token := strings.TrimSuffix(strings.TrimPrefix(header, "<https://shorted.com.au/api/alerts/unsubscribe?t="), ">")
	id, ok := unsubscribe.ParseAlertMonitorToken(token, e2eUnsubKey)
	if !ok || id != "m1" {
		t.Fatalf("the List-Unsubscribe token must name m1, got %q ok=%v", id, ok)
	}

	// The pause the public RPC performs, written as its SQL.
	mustExec(t, e.pool, `UPDATE alert_monitors SET status = 'paused' WHERE id = 'm1'`)
	e.day("2026-10-15", materialsDay(4.00, 5.00, 7.00))
	e.day("2026-10-16", materialsDay(5.50, 5.00, 7.00))
	e.wantExit(e.run(), 0, "the paused monitor's next crossing")
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm1' AND report_date = '2026-10-16'`); got != 0 {
		t.Fatalf("a paused monitor fired on a later crossing: %d events", got)
	}
}

// TestAlertsE2EReplay is case 12: a replay for one owner touches only that owner.
func TestAlertsE2EReplay(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.billing.setStatus("u2", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")

	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	e.wantExit(e.run(), 0, "first crossing")

	// Monitors created after the first evaluation would fire on 14 October if it ran again.
	e.monitor("m3", "u1", u1Email, "stock", "BBB", "short_interest_rises", "daily", new(0.5), "")
	e.monitor("m4", "u2", u2Email, "stock", "BBB", "short_interest_rises", "daily", new(0.5), "")

	e.wantExit(e.run("-date", "2026-10-14", "-user", "u1"), 0, "replay for one owner")
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm3'`); got != 1 {
		t.Fatalf("the replayed owner's new monitor must fire, events = %d", got)
	}
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm4'`); got != 0 {
		t.Fatalf("a replay for u1 must not touch u2's monitors, events = %d", got)
	}
	if d, _ := e.watermarks(); d != "2026-10-14" {
		t.Fatalf("a replay must not move the watermark, got %s", d)
	}
}

// TestAlertsE2EDryRun is case 13: with ALERTS_DRY_RUN unset, nothing is written or sent.
func TestAlertsE2EDryRun(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))

	t.Setenv("ALERTS_DRY_RUN", "")
	runsBefore := e.count(`SELECT count(*) FROM alert_evaluator_runs`)
	sent := e.resend.count()
	e.wantExit(e.run(), 0, "dry run with the env unset")
	if e.count(`SELECT count(*) FROM alert_events`) != 0 {
		t.Fatal("a dry run wrote events")
	}
	if d, _ := e.watermarks(); d != "2026-10-13" {
		t.Fatalf("a dry run moved the watermark: %s", d)
	}
	if e.resend.count() != sent {
		t.Fatal("a dry run sent email")
	}
	if e.count(`SELECT count(*) FROM alert_evaluator_runs`) != runsBefore {
		t.Fatal("a dry run wrote a run row")
	}
}

// TestAlertsE2EDryRunHoldExitsZero: a dry run that would hold a date exits 0. The hold
// is logged, not returned, and nothing is written. Only a live run is DEGRADED.
func TestAlertsE2EDryRunHoldExitsZero(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.day("2026-10-13", baseDay0())
	e.syncRow("asic", "completed", "3 hours")
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	e.syncRow("asic", "failed", "1 minute")

	t.Setenv("ALERTS_DRY_RUN", "")
	e.wantExit(e.run(), 0, "a dry run exits 0 even when a live run would hold the date")
	if d, _ := e.watermarks(); d != "2026-10-13" {
		t.Fatalf("a dry run moved the watermark: %s", d)
	}
	if e.count(`SELECT count(*) FROM alert_events`) != 0 {
		t.Fatal("a dry run wrote events")
	}
}

// TestAlertsE2EExpiredPending is case 14: a pending email 49 hours old is expired and
// never sent.
func TestAlertsE2EExpiredPending(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")

	mustExec(t, e.pool, `
		INSERT INTO alert_events (monitor_id, user_id, scope, target, condition, threshold, cadence,
		                          report_date, compared_to_date, payload, email_status, created_at)
		VALUES ('m1', 'u1', 'stock', 'AAA', 'short_interest_above', 5, 'daily',
		        '2026-10-01', '2026-09-30', '{"companies":[],"companies_total":0}', 'pending', now() - interval '49 hours')`)
	e.wantExit(e.run(), 0, "the run that expires the row")
	evs := e.events(`WHERE report_date = '2026-10-01'`)
	if len(evs) != 1 || evs[0].status != "failed" || evs[0].lastError != "expired" {
		t.Fatalf("expired row = %+v", evs)
	}
	if got := len(requestsTo(e.resend.snapshot(), u1Email)); got != 0 {
		t.Fatalf("an expired alert must never be sent, but %d emails went out", got)
	}
}

// seedTwoOwnerEvents runs the bootstrap and one crossing day, leaving two pending
// emails to u1 (a stock and an industry alert) ready for a delivery failure to hit.
func seedTwoOwnerEvents(e *e2e) {
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.monitor("m3", "u1", u1Email, "industry", "Materials", "short_interest_above", "daily", new(float64(5)), "")
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
}

// TestAlertsE2ECredentialStop: a refused key stops sending, exits 1, and refunds every
// claim, so no attempt is spent on a key Resend will not accept.
func TestAlertsE2ECredentialStop(t *testing.T) {
	e := newE2E(t)
	seedTwoOwnerEvents(e)
	e.resend.setReject(u1Email, http.StatusUnauthorized, "missing_api_key")

	e.wantExit(e.run(), 1, "a refused key")
	evs := e.events(`WHERE report_date = '2026-10-14' AND monitor_id IN ('m1', 'm3')`)
	if len(evs) != 2 {
		t.Fatalf("events = %d, want 2", len(evs))
	}
	for _, ev := range evs {
		if ev.status != "pending" || ev.attempts != 0 {
			t.Fatalf("a credential stop must return the claim unspent: %+v", ev)
		}
	}
}

// TestAlertsE2EQuotaStop: a spent daily quota stops sending, returns the rest to
// pending without an attempt, and exits 10 so the page fires.
func TestAlertsE2EQuotaStop(t *testing.T) {
	e := newE2E(t)
	seedTwoOwnerEvents(e)
	e.resend.setReject(u1Email, http.StatusTooManyRequests, "daily_quota_exceeded")

	e.wantExit(e.run(), 10, "a spent quota")
	evs := e.events(`WHERE report_date = '2026-10-14' AND monitor_id IN ('m1', 'm3')`)
	for _, ev := range evs {
		if ev.status != "pending" || ev.attempts != 0 {
			t.Fatalf("a quota stop must return the claim unspent: %+v", ev)
		}
	}
	if got := len(requestsTo(e.resend.snapshot(), u1Email)); got != 1 {
		t.Fatalf("sending must stop at the quota: %d requests reached the owner", got)
	}
}

// TestAlertsE2EPermanentFailure: a request Resend will never accept is failed at once,
// not retried, and the run is degraded.
func TestAlertsE2EPermanentFailure(t *testing.T) {
	e := newE2E(t)
	seedTwoOwnerEvents(e)
	e.resend.setReject(u1Email, http.StatusUnprocessableEntity, "validation_error")

	e.wantExit(e.run(), 10, "a permanent rejection")
	evs := e.events(`WHERE report_date = '2026-10-14' AND monitor_id IN ('m1', 'm3')`)
	for _, ev := range evs {
		if ev.status != "failed" || !strings.Contains(ev.lastError, "status 422") {
			t.Fatalf("a permanent rejection must fail the row: %+v", ev)
		}
		if ev.attempts != 1 {
			t.Fatalf("a permanent rejection is one attempt, got %d", ev.attempts)
		}
	}
	if got := len(requestsTo(e.resend.snapshot(), u1Email)); got != 2 {
		t.Fatalf("a permanent rejection is not retried: %d requests", got)
	}
}

// ---- helpers ---------------------------------------------------------------

// codesIn lists the payload's codes in order, comma-joined.
func codesIn(p alertevents.Payload) string {
	var codes []string
	for _, c := range p.Companies {
		codes = append(codes, c.Code)
	}
	return strings.Join(codes, ",")
}

// TestAlertsE2EStockDetail: a stock event stores the detail the email shows, so a
// retry renders the same bytes. The logo is the icon, the rank counts every code
// with a reading that day, and the history stops at the report date.
func TestAlertsE2EStockDetail(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	mustExec(t, e.pool, `UPDATE "company-metadata" SET logo_icon_gcs_url = 'https://logos.test/AAA_icon.PNG?v=2', logo_gcs_url = 'https://logos.test/AAA-wordmark.png' WHERE stock_code = 'AAA'`)
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")

	// Three readings, so the event's history is long enough for a chart.
	e.day("2026-10-12", baseDay0())
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	mustExec(t, e.pool, `UPDATE shorts SET "REPORTED_SHORT_POSITIONS" = 1240000000, "TOTAL_PRODUCT_IN_ISSUE" = 12100000000 WHERE "PRODUCT_CODE" = 'AAA' AND "DATE" = '2026-10-14'`)
	e.wantExit(e.run(), 0, "first crossing")

	var raw []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT payload FROM alert_events WHERE monitor_id = 'm1' AND report_date = '2026-10-14'`).Scan(&raw); err != nil {
		t.Fatalf("read event payload: %v", err)
	}
	var p alertevents.Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	if p.Stock == nil {
		t.Fatalf("the stock event must carry its detail: %s", raw)
	}
	st := p.Stock
	if st.Name != "Aaa Resources Ltd" || st.Industry != "Materials" || st.LogoURL != "https://logos.test/AAA_icon.PNG?v=2" {
		t.Fatalf("identity = %+v; the icon must be preferred", st)
	}
	if st.SharesShort == nil || *st.SharesShort != 1240000000 || st.SharesOnIssue == nil || *st.SharesOnIssue != 12100000000 {
		t.Fatalf("share counts = %v / %v", st.SharesShort, st.SharesOnIssue)
	}
	// materialsDay(5.20, ...) puts AAA behind BBB (6.50) and CCC (7.00) among the
	// 13 codes with readings that day.
	if st.Rank != 3 || st.Ranked != 13 {
		t.Fatalf("rank = %d of %d, want 3 of 13", st.Rank, st.Ranked)
	}
	if len(st.History) == 0 || st.History[len(st.History)-1].D != "2026-10-14" {
		t.Fatalf("history must end at the report date: %+v", st.History)
	}
	if st.Change20 != nil {
		t.Fatalf("a short history has no 20-report change, got %v", *st.Change20)
	}
	if len(p.Companies) != 1 || p.Companies[0].LogoURL != "https://logos.test/AAA_icon.PNG?v=2" {
		t.Fatalf("the company must carry its logo too: %+v", p.Companies)
	}

	// The email Resend received carries the chart and the brand mark inline, each
	// under the Content-ID its HTML refers to.
	reqs := requestsTo(e.resend.snapshot(), u1Email)
	if len(reqs) == 0 {
		t.Fatal("no customer email captured")
	}
	var body struct {
		HTML        string `json:"html"`
		Attachments []struct {
			ContentID string `json:"content_id"`
		} `json:"attachments"`
	}
	if err := json.Unmarshal(reqs[0].raw, &body); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, a := range body.Attachments {
		got[a.ContentID] = true
	}
	if !got["chart"] || !got["chart-dark"] || !got["shorted-mark"] || len(got) != 3 {
		t.Fatalf("attachments = %v, want the light and dark charts and the brand mark inline", got)
	}
	if !strings.Contains(body.HTML, `src="cid:chart"`) || !strings.Contains(body.HTML, `src="cid:chart-dark"`) || !strings.Contains(body.HTML, `src="cid:shorted-mark"`) {
		t.Fatal("the HTML must refer to both attachments by cid")
	}
}

// nonFiniteRun drives a firing stock whose data holds one non-finite value, and
// checks the run still succeeds and the alert still goes out. The value is set by
// the caller on a row of the fixture.
func nonFiniteRun(t *testing.T, poison func(e *e2e)) {
	t.Helper()
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")

	e.day("2026-10-12", baseDay0())
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	poison(e)
	e.wantExit(e.run(), 0, "a non-finite value must not fail the run")

	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm1' AND report_date = '2026-10-14' AND email_status = 'sent'`); got != 1 {
		t.Fatalf("the alert must be sent: %d sent events", got)
	}
	if n := len(requestsTo(e.resend.snapshot(), u1Email)); n != 1 {
		t.Fatalf("Resend received %d emails for the owner, want 1", n)
	}
}

// NaN shares on the firing report row: the alert goes out and its share counts are unknown.
func TestAlertsE2ENonFiniteShares(t *testing.T) {
	nonFiniteRun(t, func(e *e2e) {
		mustExec(e.t, e.pool, `UPDATE shorts SET "REPORTED_SHORT_POSITIONS" = 'NaN'::float8, "TOTAL_PRODUCT_IN_ISSUE" = 'Infinity'::float8 WHERE "PRODUCT_CODE" = 'AAA' AND "DATE" = '2026-10-14'`)
	})
}

// NaN percent in an earlier history row: the alert goes out with the other readings.
func TestAlertsE2ENonFiniteHistory(t *testing.T) {
	nonFiniteRun(t, func(e *e2e) {
		mustExec(e.t, e.pool, `UPDATE shorts SET "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" = 'NaN'::float8 WHERE "PRODUCT_CODE" = 'AAA' AND "DATE" = '2026-10-12'`)
	})
}

// A company with only a wordmark on file, and no icon, is drawn as a monogram: the
// wordmark column is never read, so its URL never reaches the payload.
func TestAlertsE2EWordmarkOnlyIsAMonogram(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	mustExec(t, e.pool, `UPDATE "company-metadata" SET logo_gcs_url = 'https://logos.test/AAA-wordmark.png' WHERE stock_code = 'AAA'`)
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.day("2026-10-12", baseDay0())
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	e.wantExit(e.run(), 0, "first crossing")
	var raw []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT payload FROM alert_events WHERE monitor_id = 'm1' AND report_date = '2026-10-14'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var p alertevents.Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	if p.Companies[0].LogoURL != "" || (p.Stock != nil && p.Stock.LogoURL != "") {
		t.Fatalf("a wordmark-only company must carry no logo: %+v", p.Companies[0])
	}
}

// A monitor whose address bounced earlier fires, but its alert is never sent: the
// row is skipped_suppressed and Resend receives nothing for that address. The
// suppression is written the way the webhook writes it (lower-cased).
func TestAlertsE2ESuppressedAddressIsNotSent(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")

	mustExec(t, e.pool, `INSERT INTO alert_email_suppressions (email, reason, resend_email_id) VALUES ($1, 'bounced', 'em_old')`,
		strings.ToLower(u1Email))

	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))
	e.wantExit(e.run(), 0, "the crossing day")

	var status string
	if err := e.pool.QueryRow(e.ctx, `SELECT email_status FROM alert_events WHERE monitor_id = 'm1' AND report_date = '2026-10-14'`).Scan(&status); err != nil {
		t.Fatalf("m1 did not fire on 14 Oct: %v", err)
	}
	if status != "skipped_suppressed" {
		t.Fatalf("m1 = %s, want skipped_suppressed", status)
	}
	for _, req := range e.resend.snapshot() {
		if strings.EqualFold(req.to, u1Email) {
			t.Fatalf("a suppressed address received an email: %+v", req)
		}
	}
}
