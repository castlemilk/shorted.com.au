package alerts

// Cases from the review of the evaluator. Each is a failure that the first suite
// could not see, because it drove one owner, one date or a healthy pause link.
// Like e2e_pg_test.go, they need ALERTS_TEST_DATABASE_URL and skip without it.

import (
	"testing"

	"connectrpc.com/connect"
)

// TestAlertsE2EOwnerLookupIsolated: one owner's lookup fails for that owner alone.
// Their alert waits as awaiting_entitlement. Everyone else's is emailed, and the
// watermark moves, so the failure holds no other customer back. When the lookup
// recovers, the next run sends the waiting alert.
func TestAlertsE2EOwnerLookupIsolated(t *testing.T) {
	e := newE2E(t)
	e.seedBase()
	e.billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	e.billing.setStatus("u2", "SUBSCRIPTION_STATUS_ACTIVE")
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", fp(5), "")
	e.monitor("m2", "u2", u2Email, "stock", "EEE", "short_interest_above", "daily", fp(5), "")
	e.day("2026-10-13", baseDay0())
	e.wantExit(e.run(), 0, "bootstrap")
	e.day("2026-10-14", materialsDay(5.20, 5.00, 7.00))

	e.billing.failFor("u2", connect.CodeResourceExhausted)
	e.wantExit(e.run(), 10, "u2's lookup fails, for u2 alone")
	if d, _ := e.watermarks(); d != "2026-10-14" {
		t.Fatalf("one owner's lookup must not hold the watermark, got %s", d)
	}
	if got := len(requestsTo(e.resend.snapshot(), u1Email)); got != 1 {
		t.Fatalf("u1 must be emailed, got %d requests", got)
	}
	if got := len(requestsTo(e.resend.snapshot(), u2Email)); got != 0 {
		t.Fatalf("u2 must not be emailed before the lookup works, got %d", got)
	}
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm2' AND email_status = 'awaiting_entitlement'`); got != 1 {
		t.Fatalf("u2's alert must wait for its lookup, awaiting = %d", got)
	}

	e.billing.clearFail("u2")
	e.wantExit(e.run(), 0, "the next run resolves the waiting alert")
	if got := len(requestsTo(e.resend.snapshot(), u2Email)); got != 1 {
		t.Fatalf("u2's waiting alert must be sent once the lookup works, got %d", got)
	}
	if got := e.count(`SELECT count(*) FROM alert_events WHERE monitor_id = 'm2' AND email_status = 'sent'`); got != 1 {
		t.Fatalf("u2's alert must be sent, sent = %d", got)
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
	e.monitor("m1", "u1", u1Email, "stock", "AAA", "short_interest_above", "daily", fp(5), "")
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
