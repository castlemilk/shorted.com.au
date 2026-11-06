package strategies

import (
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
)

// paperDay is a civil date in November 2026.
func paperDay(d int) civil.Date { return civil.Date{Year: 2026, Month: time.November, Day: d} }

// TestPruneKeepsSessionsThePaperTrackNeeds is the retention rule of the paper
// track: the cut-off is the earlier of the fifteenth newest completed session and
// the paper guard, and the guard is the newest session a track recorded, or, for a
// track with no record, the session before its live_from.
func TestPruneKeepsSessionsThePaperTrackNeeds(t *testing.T) {
	// Twenty calendar sessions, newest first, from Wednesday 18 November 2026.
	var completed []civil.Date
	for i := 0; i < 20; i++ {
		completed = append(completed, paperDay(18).AddDays(-i))
	}
	keep15 := completed[keepSessions-1] // Wednesday 4 November

	cases := []struct {
		name     string
		liveFrom map[string]civil.Date
		labels   map[string]string
		recorded map[string]civil.Date
		want     civil.Date
	}{
		{
			name:     "a lagging paper track keeps the session it reads next",
			liveFrom: map[string]civil.Date{"v1": completed[0]},
			labels:   map[string]string{"v1": "v1"},
			recorded: map[string]civil.Date{"v1": completed[19]},
			want:     completed[19],
		},
		{
			name:     "a track that has recorded nothing keeps the session before live_from (a missing paper table reads the same)",
			liveFrom: map[string]civil.Date{"v1": paperDay(13).AddDays(3)}, // Monday 16 November
			labels:   map[string]string{"v1": "v1"},
			// Friday 13 is after keep15, so the guard never lowers the cut-off below it.
			want: keep15,
		},
		{
			name:     "a version with no recipe has no paper rows and keeps the session before live_from",
			liveFrom: map[string]civil.Date{"v1-norecipe": paperDay(4)}, // Wednesday 4 November
			labels:   map[string]string{"v1-norecipe": "v1"},
			want:     paperDay(3), // Tuesday 3 November, before live_from: the seed
		},
		{
			name:     "v0 alone has no guard",
			liveFrom: map[string]civil.Date{"v0": completed[19]},
			labels:   map[string]string{"v0": "v0"},
			want:     keep15,
		},
		{
			name:     "a recorded session newer than keep15 does not move the cut-off",
			liveFrom: map[string]civil.Date{"v1": completed[0]},
			labels:   map[string]string{"v1": "v1"},
			recorded: map[string]civil.Date{"v1": completed[3]},
			want:     keep15,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pruneCutoff(completed, paperGuardSessions(tc.liveFrom, tc.labels, tc.recorded))
			if got != tc.want {
				t.Fatalf("cut-off = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestPaperGuardIsTheNewestRecordedSession(t *testing.T) {
	guards := paperGuardSessions(
		map[string]civil.Date{"v1": paperDay(12)},
		map[string]string{"v1": "v1"},
		map[string]civil.Date{"v1": paperDay(11)},
	)
	if len(guards) != 1 || guards[0] != paperDay(11) {
		t.Fatalf("guards = %v, want the recorded session 11 November, not the seed", guards)
	}
}

// TestSessionOnOrAfterSkipsTheWeekend keeps a track's first step on a trading day.
func TestSessionOnOrAfterSkipsTheWeekend(t *testing.T) {
	saturday := paperDay(14)
	if got := sessionOnOrAfter(saturday); got != paperDay(16) {
		t.Errorf("sessionOnOrAfter(Saturday 14) = %s, want Monday 16", got)
	}
	if got := sessionOnOrAfter(paperDay(12)); got != paperDay(12) {
		t.Errorf("a trading day is its own session: got %s", got)
	}
}

// TestPaperTransitionsAreForwardOnly is the append-only rule of the trade table.
func TestPaperTransitionsAreForwardOnly(t *testing.T) {
	legal := [][2]string{
		{"pending_entry", "open"},
		{"pending_entry", "cancelled"},
		{"open", "pending_exit"},
		{"open", "closed"},
		{"pending_exit", "closed"},
	}
	for _, m := range legal {
		if !paperMayMove(m[0], m[1]) {
			t.Errorf("%s -> %s must be allowed", m[0], m[1])
		}
	}
	// A fill and the move after it on the same session are two rows, in order.
	for _, m := range []struct {
		from, to string
		path     []string
	}{
		{"pending_entry", "pending_exit", []string{"open", "pending_exit"}},
		{"pending_entry", "closed", []string{"open", "closed"}},
		{"open", "closed", []string{"closed"}},
	} {
		got, ok := paperPath(m.from, m.to)
		if !ok || len(got) != len(m.path) || got[0] != m.path[0] || got[len(got)-1] != m.path[len(m.path)-1] {
			t.Errorf("paperPath(%s, %s) = %v, %v; want %v", m.from, m.to, got, ok, m.path)
		}
	}
	if _, ok := paperPath("closed", "open"); ok {
		t.Error("a closed trade has no path back to open")
	}
	illegal := [][2]string{
		{"open", "pending_entry"},
		{"pending_exit", "open"},
		{"closed", "open"},
		{"closed", "pending_exit"},
		{"cancelled", "open"},
		{"pending_exit", "cancelled"},
		{"cancelled", "pending_entry"},
	}
	for _, m := range illegal {
		if paperMayMove(m[0], m[1]) {
			t.Errorf("%s -> %s must be refused", m[0], m[1])
		}
	}
}

// TestPaperLedgerRowsFollowTheTrade maps the simulator's state after a session to
// the trade rows the table records: a scheduled entry, an open position with its
// queued exit, a closed trade and a cancelled entry, which keeps its signal date
// from before the session.
func TestPaperLedgerRowsFollowTheTrade(t *testing.T) {
	before := []backtest.PendingEntry{{Code: "BBB", SignalDate: paperDay(10), Pivot: 9}}
	pending := []backtest.PendingEntry{{Code: "CCC", SignalDate: paperDay(12), Pivot: 4}}
	holdings := []backtest.Holding{{
		Code: "AAA", SignalDate: paperDay(9), EntryDate: paperDay(10), EntryFill: 10.5,
		Quantity: 100, Pivot: 10, Flags: []string{"fallback_close"},
		ExitPending: true, ExitSignalDate: paperDay(12), ExitReason: "pivot_stop",
	}}
	closed := []backtest.Trade{{
		Code: "DDD", SignalDate: paperDay(2), EntryDate: paperDay(3), EntryFill: 7, Pivot: 6.5, Qty: 10,
		ExitSignalDate: paperDay(5), ExitDate: paperDay(6), ExitFill: 8, ExitReason: "time_stop",
		Flags: []string{"stale_marks"},
	}}
	events := []backtest.Event{{Date: paperDay(12), Code: "BBB", Kind: backtest.EventEntryCancelled, Reason: backtest.CancelCash}}

	rows, err := paperLedgerRows(before, pending, holdings, closed, events)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		status, code string
		signal       civil.Date
	}{
		{"pending_entry", "CCC", paperDay(12)},
		{"pending_exit", "AAA", paperDay(9)},
		{"closed", "DDD", paperDay(2)},
		{"cancelled", "BBB", paperDay(10)},
	}
	if len(rows) != len(want) {
		t.Fatalf("got %d rows, want %d: %+v", len(rows), len(want), rows)
	}
	for i, w := range want {
		if rows[i].Status != w.status || rows[i].Code != w.code || rows[i].SignalDate != w.signal {
			t.Errorf("row %d = %s %s %s, want %s %s %s", i, rows[i].Status, rows[i].Code, rows[i].SignalDate, w.status, w.code, w.signal)
		}
	}
	if !rows[1].HasEntry || rows[1].EntryPrice != 10.5 || rows[1].ExitReason != "pivot_stop" || rows[1].ExitSignalDate != paperDay(12) {
		t.Errorf("pending exit lost its entry or its queued exit: %+v", rows[1])
	}
	if rows[2].ExitPrice != 8 || !rows[2].HasExitPrice || rows[2].ExitDate != paperDay(6) {
		t.Errorf("closed trade lost its exit: %+v", rows[2])
	}
	if len(rows[3].Flags) != 1 || rows[3].Flags[0] != backtest.CancelCash {
		t.Errorf("cancelled entry should carry its reason: %+v", rows[3])
	}

	if _, err := paperLedgerRows(nil, nil, nil, nil, events); err == nil {
		t.Error("a cancellation with no pending entry before the session is an error, not a dropped row")
	}
}
