package alerts

// Cases from the review of the evaluator. Each is a failure that the first suite
// could not see, because it drove one owner, one date or a healthy pause link.
// Like e2e_pg_test.go, they need ALERTS_TEST_DATABASE_URL and skip without it.

import (
	"testing"

	"connectrpc.com/connect"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// TestAlertsE2EOwnerLookupFailsClosed: an entitlement lookup that gives no definitive
// answer fails the run before anything is committed, whichever way it failed and whether
// the whole API or one owner's answer did. No event is written, the watermark stays, and
// no customer mail goes out, not even the other owner's. Once the lookup answers, the
// next run evaluates the same date and sends each alert exactly once.
func TestAlertsE2EOwnerLookupFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name string
		code connect.Code
	}{
		{"per-owner quota", connect.CodeResourceExhausted},
		{"no account", connect.CodeNotFound},
		{"refused for one owner", connect.CodePermissionDenied},
		{"server error for one owner", connect.CodeInternal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newE2E(t)
			e.seedBase()
			e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
			e.billing.setStatus("u2", "SUBSCRIPTION_STATUS_ACTIVE")
			e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
			e.monitor("m2", "u2", u2Email, "stock", "EEE", "short_interest_above", "daily", new(float64(5)), "")
			e.day("2026-10-13", baseDay0())
			e.wantExit(e.run(), 0, "bootstrap")
			e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))

			e.billing.failFor("u2", tc.code)
			e.wantExit(e.run(), 1, "one owner's lookup gave no answer")
			if d, _ := e.watermarks(); d != "2026-10-13" {
				t.Fatalf("a failed lookup must not move the watermark, got %s", d)
			}
			if got := e.count(`SELECT count(*) FROM alert_events`); got != 0 {
				t.Fatalf("a failed lookup must commit no event, wrote %d", got)
			}
			if got := len(requestsTo(e.resend.snapshot(), u1Email)) + len(requestsTo(e.resend.snapshot(), u2Email)); got != 0 {
				t.Fatalf("no customer mail may go out past a failed lookup, got %d", got)
			}

			e.billing.clearFail("u2")
			e.wantExit(e.run(), 0, "the next run, with the lookup answering")
			if got := len(requestsTo(e.resend.snapshot(), u1Email)); got != 1 {
				t.Fatalf("u1 must be emailed once the lookup answers, got %d", got)
			}
			if got := len(requestsTo(e.resend.snapshot(), u2Email)); got != 1 {
				t.Fatalf("u2 must be emailed once the lookup answers, got %d", got)
			}
			if got := e.count(`SELECT count(*) FROM alert_events WHERE email_status = 'sent'`); got != 2 {
				t.Fatalf("both alerts must be sent exactly once, sent = %d", got)
			}
		})
	}
}

// TestAlertsE2EVanishedMonitorIsSkippedAndCounted: a monitor deleted after the run read
// it must not fail the run for everyone. The commit skips its row, counts it as vanished,
// and commits every other row and the watermark as usual.
func TestAlertsE2EVanishedMonitorIsSkippedAndCounted(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	base := Message{Scope: "stock", Target: "AAA", Condition: "short_interest_above", Cadence: "daily",
		Threshold: new(float64(5)), ReportDate: "2026-10-14", ComparedTo: "2026-10-13"}
	gone := base
	gone.Target = "EEE"
	rows := []eventRow{
		{monitorID: "m1", userID: "u1", msg: base, status: alertevents.StatusPending},
		{monitorID: "deleted-after-the-read", userID: "u9", msg: gone, status: alertevents.StatusPending},
	}

	st := store{pool: e.pool}
	applied, inserted, vanished, err := st.commit(e.ctx, State{}, State{}, true, 0, rows)
	if err != nil {
		t.Fatalf("a vanished monitor must not fail the commit: %v", err)
	}
	if !applied || inserted != 1 || vanished != 1 {
		t.Fatalf("applied=%v inserted=%d vanished=%d, want true 1 1", applied, inserted, vanished)
	}
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm1'`); got != 1 {
		t.Fatalf("the live monitor's event must commit, events = %d", got)
	}
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'deleted-after-the-read'`); got != 0 {
		t.Fatalf("the vanished monitor's event must not be written, events = %d", got)
	}
}

// TestAlertsE2EWeeklyWaitsForHeldDay: a week whose Friday is still half-written is
// not compared, because its comparison would read the held day and the watermark
// would then skip the week for good. Once Friday is whole, the week is compared
// exactly once, against the previous Friday.
func TestAlertsE2EWeeklyWaitsForHeldDay(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	rise := 0.30
	e.monitor("w1", "u1", u1Email, "stock", "AAA", "short_interest_rises", "weekly", &rise, "")
	e.day("2026-10-09", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	for _, d := range []string{"2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"} {
		e.day(d, materialsDay(4.80, 4.99, 7.00))
	}
	e.day("2026-10-16", map[string]float64{"AAA": 5.20, "BBB": 6.50, "EEE": 4.99})

	e.wantExit(e.run(), 10, "Friday is half-written")
	if d, w := e.watermarks(); d != "2026-10-15" || w != "2026-10-09" {
		t.Fatalf("watermarks = daily %s weekly %s, want 2026-10-15 and 2026-10-09", d, w)
	}
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'w1'`); got != 0 {
		t.Fatalf("a week that reaches a held day must not be compared, events = %d", got)
	}

	mustExec(t, e.pool, `DELETE FROM shorts WHERE "DATE" = '2026-10-16'`)
	e.day("2026-10-16", materialsDay(5.20, 4.99, 7.00))
	e.wantExit(e.run(), 0, "a whole Friday evaluates the week")
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'w1' AND report_date = '2026-10-16' AND compared_to_date = '2026-10-09'`); got != 1 {
		t.Fatalf("the week must be compared once, against the previous Friday, events = %d", got)
	}
	if _, w := e.watermarks(); w != "2026-10-16" {
		t.Fatalf("weekly watermark = %s, want 2026-10-16", w)
	}
}

// TestAlertsE2EPauseLinkMustVerify: when the job's copy of UNSUBSCRIBE_SECRET no
// longer verifies (a rotation the job never picked up), the canary fails the one-click
// round trip, and no customer mail goes out. The alert waits as pending. Once the
// secret is restored, the next run sends it.
func TestAlertsE2EPauseLinkMustVerify(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))

	t.Setenv("UNSUBSCRIBE_SECRET", "rotated-but-not-picked-up")
	e.wantExit(e.run(), 1, "the canary's pause link does not verify")
	if got := len(requestsTo(e.resend.snapshot(), u1Email)); got != 0 {
		t.Fatalf("no customer mail may go out when the pause link fails, got %d", got)
	}
	var id int64
	if err := e.pool.QueryRow(e.ctx, `SELECT id FROM alert_events WHERE monitor_id = 'm1'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	e.wantStatus(id, "pending")

	t.Setenv("UNSUBSCRIBE_SECRET", e2eUnsubKey)
	e.wantExit(e.run(), 0, "the waiting alert goes out once the link verifies")
	if got := len(requestsTo(e.resend.snapshot(), u1Email)); got != 1 {
		t.Fatalf("the alert must be sent once the link verifies, got %d", got)
	}
}

// TestAlertsE2ELegacyAwaitingRowExpires: the evaluator no longer writes
// awaiting_entitlement, but a row an earlier build wrote must not wait forever. It expires
// after 48 hours, as a pending row does, and a run with nothing else to do still expires it.
func TestAlertsE2ELegacyAwaitingRowExpires(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", new(float64(5)), "")
	mustExec(t, e.pool, `
		INSERT INTO alert_events (monitor_id, user_id, scope, target, condition, threshold, cadence,
		                          report_date, compared_to_date, latest_percent, previous_percent,
		                          email_status, created_at)
		VALUES ('m1', 'u1', 'stock', 'AAA', 'short_interest_above', 5, 'daily',
		        '2026-10-14', '2026-10-13', 5.2, 4.8, 'awaiting_entitlement', now() - interval '49 hours')`)
	st := store{pool: e.pool}
	if err := st.expirePending(e.ctx); err != nil {
		t.Fatal(err)
	}
	var status, lastErr string
	if err := e.pool.QueryRow(e.ctx, `SELECT email_status, last_error FROM alert_events WHERE monitor_id = 'm1'`).Scan(&status, &lastErr); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || lastErr != "expired: entitlement lookup never succeeded" {
		t.Fatalf("legacy awaiting row = %s %q, want failed and expired", status, lastErr)
	}
}
