package alerts

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// fullDay is a report with n codes, enough for the completeness guard to compare
// against.
func fullDay(n int) map[string]float64 {
	rows := make(map[string]float64, n)
	for i := 0; i < n; i++ {
		rows[fmt.Sprintf("X%02d", i)] = 1
	}
	return rows
}

// A week whose last report is a held date is not compared. Comparing it would read
// the half-written day, and the watermark would then move past the held date.
func TestWeeklyDoesNotReachAHeldDay(t *testing.T) {
	dates := []Date{"2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-09", "2026-10-08"}
	rows := map[Date]map[string]float64{
		"2026-10-16": fullDay(3), // Friday, half-written
		"2026-10-15": fullDay(30), "2026-10-14": fullDay(30), "2026-10-13": fullDay(30),
		"2026-10-12": fullDay(30), "2026-10-09": fullDay(30), "2026-10-08": fullDay(30),
	}
	state := State{DailyThrough: "2026-10-15", WeeklyThrough: "2026-10-09"}
	plan := PlanRun(state, snapOf(dates, rows, nil))
	if plan.Held != "2026-10-16" {
		t.Fatalf("held = %q, want the half-written Friday", plan.Held)
	}
	if len(plan.Weekly) != 0 {
		t.Fatalf("a week reaching a held day must wait, got %+v", plan.Weekly)
	}
	if plan.Next.WeeklyThrough != "2026-10-09" {
		t.Fatalf("weekly watermark moved to %s past a held day", plan.Next.WeeklyThrough)
	}
}

// A Friday backfilled after its week was evaluated (against Thursday, because a later
// week existed) must not evaluate that week a second time.
func TestBackfilledFridayDoesNotReevaluateTheWeek(t *testing.T) {
	dates := []Date{"2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-09"}
	state := State{DailyThrough: "2026-10-15", WeeklyThrough: "2026-10-15"}
	plan := PlanRun(state, snapOf(dates, nil, nil))
	if len(plan.Weekly) != 0 {
		t.Fatalf("the same ISO week must not be evaluated twice, got %+v", plan.Weekly)
	}
	if plan.Next.WeeklyThrough != "2026-10-15" {
		t.Fatalf("weekly watermark = %s, want unchanged", plan.Next.WeeklyThrough)
	}
}

func TestLaterWeekComparesWeeksNotDates(t *testing.T) {
	cases := []struct {
		a, b Date
		want bool
	}{
		{"2026-10-16", "2026-10-15", false}, // Friday after Thursday, same week
		{"2026-10-12", "2026-10-09", true},  // Monday after the previous Friday
		{"2026-10-19", "2026-10-16", true},
		{"2026-10-09", "2026-10-12", false},
	}
	for _, tc := range cases {
		if got := laterWeek(tc.a, tc.b); got != tc.want {
			t.Fatalf("laterWeek(%s, %s) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

// An unsettled sync holds every fresh date, since any of them may be part-written.
// Dates the watermark already covers are untouched.
func TestUnsettledSyncHoldsEveryFreshDate(t *testing.T) {
	dates := []Date{"2026-10-16", "2026-10-15", "2026-10-14"}
	rows := map[Date]map[string]float64{"2026-10-16": fullDay(30), "2026-10-15": fullDay(30), "2026-10-14": fullDay(30)}
	state := State{DailyThrough: "2026-10-14"}

	snap := snapOf(dates, rows, nil)
	snap.SyncUnsettled = true
	plan := PlanRun(state, snap)
	if len(plan.Daily) != 0 {
		t.Fatalf("an unsettled sync must evaluate nothing, got %+v", plan.Daily)
	}
	if plan.Held != "2026-10-15" || !plan.HeldBySync {
		t.Fatalf("held = %q (by sync %v), want the oldest fresh date held by the sync", plan.Held, plan.HeldBySync)
	}
	if plan.Next.DailyThrough != "2026-10-14" {
		t.Fatalf("daily watermark moved to %s under an unsettled sync", plan.Next.DailyThrough)
	}

	settled := PlanRun(state, snapOf(dates, rows, nil))
	if len(settled.Daily) != 2 || settled.HeldBySync {
		t.Fatalf("a settled window must evaluate both fresh dates, got %+v (held %q)", settled.Daily, settled.Held)
	}
}

// The job's classification of a lookup failure: an answer about the whole API or
// the job's own credential stops the run; an answer about one owner does not.
func TestTransportWideSeparatesTheAPIFromOneOwner(t *testing.T) {
	cases := []struct {
		code connect.Code
		want bool
	}{
		{connect.CodeUnavailable, true},
		{connect.CodeDeadlineExceeded, true},
		{connect.CodeUnauthenticated, true},
		{connect.CodeCanceled, true},
		{connect.CodeResourceExhausted, false},
		{connect.CodePermissionDenied, false},
		{connect.CodeNotFound, false},
		{connect.CodeInternal, false},
	}
	for _, tc := range cases {
		err := connect.NewError(tc.code, errors.New("x"))
		if got := transportWide(err); got != tc.want {
			t.Fatalf("transportWide(%v) = %v, want %v", tc.code, got, tc.want)
		}
	}
	if !transportWide(errors.New("connection reset")) {
		t.Fatal("a non-RPC error is a transport failure")
	}
	if got := lookupCode(connect.NewError(connect.CodeResourceExhausted, errors.New("1000 requests per month"))); got != "resource_exhausted" {
		t.Fatalf("lookupCode = %q", got)
	}
}

// One owner's failed lookup holds only that owner's events, which wait as awaiting.
// Every other owner's events are decided as usual.
func TestDecideRowsHoldsOnlyTheFailedOwner(t *testing.T) {
	cands := []Candidate{
		{Monitor: Monitor{ID: "m1", UserID: "u1", Email: "a@example.com"}},
		{Monitor: Monitor{ID: "m2", UserID: "u2", Email: "b@example.com"}},
		{Monitor: Monitor{ID: "m3", UserID: "u3", Email: "c@example.com"}},
		{Monitor: Monitor{ID: "m4", UserID: "u4", Email: ""}},
	}
	owners := newOwnerState()
	owners.checked = true
	owners.ents["u1"] = entitlement{Entitled: true, Status: "ACTIVE"}
	owners.ents["u3"] = entitlement{Entitled: false, Status: "CANCELED"}
	owners.failed["u2"] = "resource_exhausted"

	rows, unentitled, noEmail, awaiting := decideRows(cands, owners)
	want := map[string]string{
		"m1": alertevents.StatusPending,
		"m2": alertevents.StatusAwaitingEntitlement,
		"m3": alertevents.StatusSkippedUnentitled,
		"m4": alertevents.StatusSkippedNoEmail,
	}
	for _, r := range rows {
		if r.status != want[r.monitorID] {
			t.Fatalf("%s status = %s, want %s", r.monitorID, r.status, want[r.monitorID])
		}
	}
	if unentitled != 1 || noEmail != 1 || awaiting != 1 {
		t.Fatalf("counts unentitled=%d noEmail=%d awaiting=%d, want 1 1 1", unentitled, noEmail, awaiting)
	}
	if !strings.Contains(rows[1].lastError, "resource_exhausted") {
		t.Fatalf("the awaiting row should name the lookup code, got %q", rows[1].lastError)
	}
}
