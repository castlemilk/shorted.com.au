package strategies

import (
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// The pure half of the daily job: the readiness truth table, the session and
// backfill selection, the prune cut-off and the event diff. None of these touch a
// database; the container suite covers the writes.

// wed is a trading day with no ASX holiday in its surrounding weeks.
var wed = civil.Date{Year: 2026, Month: time.November, Day: 11}

// readyFacts is a session whose every rule passes.
func readyFacts(s civil.Date) readinessFacts {
	start := time.Date(s.Year, s.Month, s.Day, 6, 0, 0, 0, time.UTC)
	return readinessFacts{
		Sweep:       &sweepFact{Status: "completed", StartedAt: start},
		Priced:      1800,
		PriorPriced: []int{1800, 1790, 1810, 1805, 1800, 1795, 1800, 1802, 1798, 1801},
		XJOBar:      true,
	}
}

func TestEvaluateReadinessTruthTable(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*readinessFacts)
		ready  bool
		reason string
	}{
		{name: "every rule passes", mutate: func(*readinessFacts) {}, ready: true},
		{
			name:   "an ASIC sync is writing shorts (a)",
			mutate: func(f *readinessFacts) { f.ASICSyncRunning = true },
			reason: "asic_sync_running",
		},
		{
			name:   "no price sweep row at all (b)",
			mutate: func(f *readinessFacts) { f.Sweep = nil },
			reason: "no_price_sweep",
		},
		{
			name: "the sweep started before the session's 05:30 UTC (b)",
			mutate: func(f *readinessFacts) {
				f.Sweep.StartedAt = time.Date(wed.Year, wed.Month, wed.Day, 5, 29, 0, 0, time.UTC)
			},
			reason: "price_sweep_not_yet_run",
		},
		{
			name:   "the sweep is still running (b)",
			mutate: func(f *readinessFacts) { f.Sweep.Status = "running" },
			reason: "price_sweep_running",
		},
		{
			name:   "no code has a priced bar with volume (c)",
			mutate: func(f *readinessFacts) { f.Priced = 0 },
			reason: "no_priced_codes",
		},
		{
			name:   "priced codes just under 85% of the median (c)",
			mutate: func(f *readinessFacts) { f.Priced = 1500 },
			reason: "priced_codes_1500_below_85_percent_of_median_1800",
		},
		{
			name: "priced codes exactly at 85% pass (c)",
			mutate: func(f *readinessFacts) {
				f.PriorPriced = []int{1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000}
				f.Priced = 850
			},
			ready: true,
		},
		{
			name:   "no prior history means the floor does not apply (c)",
			mutate: func(f *readinessFacts) { f.PriorPriced = nil; f.Priced = 3 },
			ready:  true,
		},
		{
			name:   "the XJO index has no bar on the session (d)",
			mutate: func(f *readinessFacts) { f.XJOBar = false },
			reason: "xjo_bar_missing",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := readyFacts(wed)
			c.mutate(&f)
			ready, reason := evaluateReadiness(wed, f)
			if ready != c.ready || reason != c.reason {
				t.Fatalf("evaluateReadiness = (%v, %q), want (%v, %q)", ready, reason, c.ready, c.reason)
			}
		})
	}
}

func TestEvaluateReadinessFirstFailureWins(t *testing.T) {
	f := readyFacts(wed)
	f.ASICSyncRunning = true
	f.XJOBar = false
	if ok, reason := evaluateReadiness(wed, f); ok || reason != "asic_sync_running" {
		t.Fatalf("rule (a) must be reported before (d): got (%v, %q)", ok, reason)
	}
}

func TestMedianInt(t *testing.T) {
	if got := medianInt(nil); got != 0 {
		t.Errorf("median of none = %v, want 0", got)
	}
	if got := medianInt([]int{5, 1, 3}); got != 3 {
		t.Errorf("median odd = %v, want 3", got)
	}
	if got := medianInt([]int{4, 1, 3, 2}); got != 2.5 {
		t.Errorf("median even = %v, want 2.5", got)
	}
}

func TestSessionForIsTodayOnATradingDayElsePrevious(t *testing.T) {
	// Wednesday 11 November 2026 is a trading day: the run's session is today.
	if got := sessionFor(wed); got != wed {
		t.Errorf("sessionFor(trading day) = %s, want %s", got, wed)
	}
	// Saturday 14 November 2026 falls back to Friday 13 November.
	sat := civil.Date{Year: 2026, Month: time.November, Day: 14}
	fri := civil.Date{Year: 2026, Month: time.November, Day: 13}
	if got := sessionFor(sat); got != fri {
		t.Errorf("sessionFor(Saturday) = %s, want %s", got, fri)
	}
}

func TestSessionsToProcessBackfillsOldestFirstWithinTheLimit(t *testing.T) {
	mon := civil.Date{Year: 2026, Month: time.November, Day: 9}
	tue := civil.Date{Year: 2026, Month: time.November, Day: 10}
	thu := civil.Date{Year: 2026, Month: time.November, Day: 12}

	if got := sessionsToProcess(nil, thu, backfillLimit); len(got) != 1 || got[0] != thu {
		t.Errorf("no complete session yet: got %v, want [%s]", got, thu)
	}
	got := sessionsToProcess(&mon, thu, backfillLimit)
	want := []civil.Date{tue, wed, thu}
	if len(got) != len(want) {
		t.Fatalf("backfill after Monday = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("backfill order = %v, want oldest first %v", got, want)
		}
	}
	if capped := sessionsToProcess(&mon, thu, 2); len(capped) != 2 || capped[0] != tue {
		t.Errorf("limit 2 = %v, want the oldest two", capped)
	}
	if none := sessionsToProcess(&thu, thu, backfillLimit); len(none) != 0 {
		t.Errorf("nothing after a complete session = %v, want none", none)
	}
}

func TestAllPhasesDone(t *testing.T) {
	if allPhasesDone(map[string]bool{phaseFeatures: true, phaseEvaluation: true}) {
		t.Error("two of three phases must not count as done")
	}
	if !allPhasesDone(map[string]bool{phaseFeatures: true, phaseEvaluation: true, phaseEvents: true}) {
		t.Error("all three phases must count as done")
	}
}

func TestMinuteOfDayDrivesTheDeadline(t *testing.T) {
	at := func(h, m int) time.Time { return time.Date(2026, 11, 11, h, m, 0, 0, time.UTC) }
	if minuteOfDay(at(16, 39)) >= deadlineMinute {
		t.Error("16:39 UTC is before the deadline")
	}
	if minuteOfDay(at(16, 40)) < deadlineMinute {
		t.Error("16:40 UTC is the deadline")
	}
}

func TestPruneCutoffKeepsFifteenSessionsAndThePaperGuard(t *testing.T) {
	var completed []civil.Date
	for i := 0; i < 20; i++ {
		completed = append(completed, wed.AddDays(-i))
	}
	keep15 := completed[keepSessions-1]

	if got := pruneCutoff(completed, nil); got != keep15 {
		t.Errorf("no guard: cutoff = %s, want the 15th newest %s", got, keep15)
	}
	earlier := keep15.AddDays(-3)
	if got := pruneCutoff(completed, []civil.Date{earlier}); got != earlier {
		t.Errorf("an earlier paper guard must win: cutoff = %s, want %s", got, earlier)
	}
	later := keep15.AddDays(2)
	if got := pruneCutoff(completed, []civil.Date{later}); got != keep15 {
		t.Errorf("a later guard must not move the cutoff: cutoff = %s, want %s", got, keep15)
	}
	if got := pruneCutoff(completed[:keepSessions-1], nil); !got.IsZero() {
		t.Errorf("fewer than %d completed sessions must delete nothing: cutoff = %s", keepSessions, got)
	}
}

func TestPaperGuardIsTheSessionBeforeLiveFromOnTheDataCalendar(t *testing.T) {
	// Monday 16 November 2026 went live: the guard is Friday 13, never the Sunday.
	monday := civil.Date{Year: 2026, Month: time.November, Day: 16}
	friday := civil.Date{Year: 2026, Month: time.November, Day: 13}
	guards := paperGuardSessions(
		map[string]civil.Date{"live-v1": monday, "v0-hash": monday, "no-date": {}},
		map[string]string{"live-v1": "v1", "v0-hash": "v0", "no-date": "v2"},
	)
	if len(guards) != 1 || guards[0] != friday {
		t.Fatalf("paper guards = %v, want [%s]: v0 and a version without live_from carry none", guards, friday)
	}
}

func TestDiffEvaluationsRecordsEachTransitionOnce(t *testing.T) {
	prev := map[string]pickState{
		"AAA": {Status: "setup", Score: 60},
		"BBB": {Status: "watch", Score: 20},
		"CCC": {Status: "triggered", Score: 90},
	}
	cur := map[string]pickState{
		"AAA": {Status: "triggered", Score: 95},
		"CCC": {Status: "setup", Score: 70},
		"DDD": {Status: "watch", Score: 10},
	}
	got := diffEvaluations(prev, cur, false)
	want := []transition{
		{Code: "AAA", From: "setup", To: "triggered", Score: 95},
		{Code: "CCC", From: "triggered", To: "setup", Score: 70},
	}
	if len(got) != len(want) {
		t.Fatalf("transitions = %+v, want the setup->triggered and triggered->setup moves only", got)
	}
	for i := range want {
		if got[i].Code != want[i].Code || got[i].From != want[i].From || got[i].To != want[i].To || got[i].Score != want[i].Score {
			t.Errorf("transition %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestDiffEvaluationsSkipsWatchNoneChurnAndRecordsExits(t *testing.T) {
	prev := map[string]pickState{"WWW": {Status: "watch", Score: 5}, "EEE": {Status: "setup", Score: 50}}
	cur := map[string]pickState{"NNN": {Status: "watch", Score: 5}}
	got := diffEvaluations(prev, cur, false)
	// WWW watch -> none is churn; NNN none -> watch is churn; EEE setup -> none is an exit.
	if len(got) != 1 || got[0].Code != "EEE" || got[0].To != noneStatus {
		t.Fatalf("transitions = %+v, want only EEE setup -> none", got)
	}
	if got[0].Score != 0 {
		t.Errorf("an exit carries no score: got %v", got[0].Score)
	}
	if scoreOrNil(got[0]) != nil {
		t.Errorf("an exit's score column must be NULL")
	}
}

func TestDiffEvaluationsBaselineHasNoEvents(t *testing.T) {
	cur := map[string]pickState{"AAA": {Status: "triggered", Score: 99}}
	if got := diffEvaluations(nil, cur, true); len(got) != 0 {
		t.Fatalf("a first session is a baseline: got %+v", got)
	}
}

func TestEvidenceJSONCarriesRuleOutcomesOnly(t *testing.T) {
	tr := transition{Code: "AAA", To: "triggered", Rules: pickState{Rules: []engine.RuleResult{{RuleID: "above_sma200", Status: engine.RulePass}}}}
	got := evidenceJSON(tr)
	want := `{"rules":[{"id":"above_sma200","status":"pass"}]}`
	if got != want {
		t.Fatalf("evidenceJSON = %s, want %s", got, want)
	}
}
