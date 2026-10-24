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
	for i := range n {
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

// A failed lookup is named by its connect code, never by its message, which could name
// an account.
func TestLookupCodeNamesTheCodeNotTheMessage(t *testing.T) {
	if got := lookupCode(connect.NewError(connect.CodeResourceExhausted, errors.New("1000 requests per month for user u1"))); got != "resource_exhausted" {
		t.Fatalf("lookupCode = %q, want resource_exhausted", got)
	}
	if got := lookupCode(errors.New("connection reset by peer")); got != "error" {
		t.Fatalf("a non-RPC failure reads as %q, want error", got)
	}
}

// decideRows is the last gate before a commit. Every owner with an address must have
// an answer; without one the run refuses, and it never sends or commits unentitled.
func TestDecideRowsRefusesAnOwnerWithNoAnswer(t *testing.T) {
	cands := []Candidate{
		{Monitor: Monitor{ID: "m1", UserID: "u1", Email: "a@example.com"}},
		{Monitor: Monitor{ID: "m3", UserID: "u3", Email: "c@example.com"}},
		{Monitor: Monitor{ID: "m4", UserID: "u4", Email: ""}},
	}
	ents := map[string]entitlement{
		"u1": {Entitled: true, Status: "ACTIVE"},
		"u3": {Entitled: false, Status: "CANCELED"},
	}
	rows, unentitled, noEmail, err := decideRows(cands, ents)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"m1": alertevents.StatusPending,
		"m3": alertevents.StatusSkippedUnentitled,
		"m4": alertevents.StatusSkippedNoEmail,
	}
	for _, r := range rows {
		if r.status != want[r.monitorID] {
			t.Fatalf("%s status = %s, want %s", r.monitorID, r.status, want[r.monitorID])
		}
	}
	if unentitled != 1 || noEmail != 1 {
		t.Fatalf("counts unentitled=%d noEmail=%d, want 1 1", unentitled, noEmail)
	}
	if !strings.Contains(rows[1].lastError, "CANCELED") {
		t.Fatalf("the unentitled row should name the status, got %q", rows[1].lastError)
	}

	cands = append(cands, Candidate{Monitor: Monitor{ID: "m2", UserID: "u2", Email: "b@example.com"}})
	if _, _, _, err := decideRows(cands, ents); err == nil {
		t.Fatal("an owner with an address and no answer must refuse, never decide")
	}
}

// An entrant that was ranked 11th or lower the day before keeps that place as its
// previous rank. Before the fix, the previous rank was read from the capped top ten,
// so it read 0, "not ranked", and the email and the events list said so.
func TestTopTenEntrantPreviousRankPastTen(t *testing.T) {
	dates := []Date{d0, d1}
	prev := map[string]float64{}
	meta := map[string]CompanyInfo{}
	for i := 1; i <= 10; i++ {
		code := "F" + pad2(i)
		prev[code] = float64(20 - i) // F01 at 19 down to F10 at 10
		meta[code] = CompanyInfo{Name: code, Industry: "Materials"}
	}
	prev["KXX"] = 9.0 // eleventh the day before
	meta["KXX"] = CompanyInfo{Name: "KXX Ltd", Industry: "Materials"}

	// KXX jumps to the top. F10 drops out of the top ten, so only KXX enters.
	cur := map[string]float64{"KXX": 30.0}
	for i := 1; i <= 9; i++ {
		cur["F"+pad2(i)] = float64(20 - i)
	}
	cur["F10"] = 9.5
	snap := snapOf(dates, map[Date]map[string]float64{d0: cur, d1: prev}, meta)

	m := mon("industry", "Materials", "new_top_ten_entry", "daily", nil)
	got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
	if len(got) != 1 || len(got[0].Payload.Companies) != 1 {
		t.Fatalf("want one event with one entrant, got %+v", got)
	}
	c := got[0].Payload.Companies[0]
	if c.Code != "KXX" || c.Rank != 1 {
		t.Fatalf("entrant = %+v, want KXX at rank 1", c)
	}
	if c.PreviousRank != 11 {
		t.Fatalf("previous rank = %d, want 11: ranked eleventh the day before, not 0 (not ranked)", c.PreviousRank)
	}
	if c.Previous == nil || *c.Previous != 9 {
		t.Fatalf("previous reading = %v, want 9", c.Previous)
	}
}
