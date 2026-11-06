package strategies

import (
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// paperDay is a civil date in November 2026, a stretch with no ASX holiday.
func paperDay(d int) civil.Date { return civil.Date{Year: 2026, Month: time.November, Day: d} }

// TestPruneKeepsSessionsThePaperTrackNeeds: the retention cut-off is the earlier of
// the fifteenth newest complete session and each track's guard. A track's guard is
// two sessions before its next step, or before its live_from when it has no
// checkpoint, and a stopped track has none.
func TestPruneKeepsSessionsThePaperTrackNeeds(t *testing.T) {
	// Twenty calendar sessions, newest first, from Wednesday 18 November 2026.
	var completed []civil.Date
	for i := 0; i < 20; i++ {
		completed = append(completed, paperDay(18).AddDays(-i))
	}
	keep15 := completed[keepSessions-1] // Wednesday 4 November

	cases := []struct {
		name  string
		guard civil.Date
		want  civil.Date
	}{
		{
			name:  "a lagging track keeps two sessions before its next step",
			guard: paperGuardOf(completed[19], true, completed[0]),
			want:  prevTradingDay(prevTradingDay(completed[18])),
		},
		{
			name:  "a track with no checkpoint keeps two sessions before live_from",
			guard: paperGuardOf(civil.Date{}, false, paperDay(16)),
			want:  paperDay(12),
		},
		{
			name:  "a guard newer than keep15 does not move the cut-off",
			guard: paperGuardOf(completed[3], true, completed[0]),
			want:  keep15,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pruneCutoff(completed, []civil.Date{tc.guard})
			want := tc.want
			if want.After(keep15) {
				want = keep15
			}
			if got != want {
				t.Fatalf("cut-off = %s, want %s (guard %s)", got, want, tc.guard)
			}
		})
	}
	if g := paperGuardOf(civil.Date{}, false, civil.Date{}); !g.IsZero() {
		t.Errorf("a track with neither a checkpoint nor a live_from has no guard: %s", g)
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
// queued exit, a closed trade with its economics, and a cancelled entry, which
// keeps its signal date from before the session.
func TestPaperLedgerRowsFollowTheTrade(t *testing.T) {
	before := []backtest.PendingEntry{{Code: "BBB", SignalDate: paperDay(10), Pivot: 9}}
	pending := []backtest.PendingEntry{{Code: "CCC", SignalDate: paperDay(12), Pivot: 4}}
	holdings := []backtest.Holding{{
		Code: "AAA", SignalDate: paperDay(9), EntryDate: paperDay(10), EntryFill: 10.5,
		Quantity: 100, Pivot: 10, Score: 71, Flags: []string{"fallback_close"},
		ExitPending: true, ExitSignalDate: paperDay(12), ExitReason: "pivot_stop",
	}}
	closed := []backtest.Trade{{
		Code: "DDD", SignalDate: paperDay(2), EntryDate: paperDay(3), EntryFill: 7, Pivot: 6.5, Qty: 10,
		EntryScore: 64, SessionsHeld: 3, Gross: 0.12, Net: 0.10, Fees: 4, Dividends: 1,
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
	if !rows[1].HasEntry || rows[1].EntryPrice != 10.5 || rows[1].ExitReason != "pivot_stop" || rows[1].ExitSignalDate != paperDay(12) || rows[1].EntryScore != 71 {
		t.Errorf("pending exit lost its entry, score or queued exit: %+v", rows[1])
	}
	c := rows[2]
	if c.ExitPrice != 8 || !c.HasExitPrice || c.ExitDate != paperDay(6) || c.SessionsHeld != 3 || c.GrossPct != 12 || c.NetPct != 10 || c.Fees != 4 || c.Dividends != 1 || !c.Closed {
		t.Errorf("closed trade lost its exit or economics: %+v", c)
	}
	if len(rows[3].Flags) != 1 || rows[3].Flags[0] != backtest.CancelCash {
		t.Errorf("cancelled entry should carry its reason: %+v", rows[3])
	}
	if _, err := paperLedgerRows(nil, nil, nil, nil, events); err == nil {
		t.Error("a cancellation with no pending entry before the session is an error, not a dropped row")
	}
}

// TestOpenStepDropsTheExitAndTheEconomics: a fill recorded before the move it is
// followed by carries no exit and no closing economics.
func TestOpenStepDropsTheExitAndTheEconomics(t *testing.T) {
	closing := paperTradeRow{Status: "closed", Code: "AAA", SignalDate: paperDay(2), HasExitPrice: true, ExitPrice: 8,
		ExitReason: "time_stop", ExitDate: paperDay(6), Closed: true, SessionsHeld: 2, GrossPct: 5, Flags: []string{"x"}}
	got := openStep(closing)
	if got.HasExitPrice || got.ExitReason != "" || !got.ExitDate.IsZero() || got.Closed || got.GrossPct != 0 {
		t.Errorf("open step kept the close: %+v", got)
	}
	if len(got.Flags) != 1 {
		t.Errorf("open step must keep the flags: %+v", got.Flags)
	}
}

// TestCAForSessionAdmitsWhatTheBatchAdmits: the seed session admits a suspect known
// earlier with its age in sessions, drops one older than the block, and takes the
// most recent; a later session takes only the suspects known since the session
// before it, with the earliest bar as the position exclusion's date.
func TestCAForSessionAdmitsWhatTheBatchAdmits(t *testing.T) {
	seed := paperDay(18)
	prev := prevTradingDay(seed)

	recent := snapshot.CAKnown{Date: paperDay(2), KnownAt: paperDay(10)}
	older := snapshot.CAKnown{Date: paperDay(1), KnownAt: paperDay(3)}
	got := caForSession([]snapshot.CAKnown{older, recent}, seed, prev, true)
	wantAge := sessionsBetweenPaper(recent.KnownAt, seed)
	if !got.Known || got.SuspectDate != recent.Date || got.Age != wantAge {
		t.Fatalf("seed admits %+v, want the recent suspect with age %d", got, wantAge)
	}

	ancient := snapshot.CAKnown{Date: paperDay(1), KnownAt: civil.Date{Year: 2026, Month: time.August, Day: 1}}
	if got := caForSession([]snapshot.CAKnown{ancient}, seed, prev, true); got.Known {
		t.Fatalf("a suspect older than the block is dropped at the seed: %+v", got)
	}

	onSeed := snapshot.CAKnown{Date: paperDay(4), KnownAt: seed}
	if got := caForSession([]snapshot.CAKnown{onSeed}, seed, prev, true); !got.Known || got.Age != 0 {
		t.Fatalf("a suspect known on the seed is known with age 0: %+v", got)
	}

	// After the seed: only what became known after prev is new, earliest bar first.
	known := []snapshot.CAKnown{
		{Date: paperDay(5), KnownAt: prev},         // known before: not new
		{Date: paperDay(9), KnownAt: paperDay(19)}, // new
		{Date: paperDay(7), KnownAt: paperDay(19)}, // new, earlier bar
		{Date: paperDay(1), KnownAt: paperDay(20)}, // after this session
	}
	got = caForSession(known, paperDay(19), paperDay(18), false)
	if !got.Known || got.SuspectDate != paperDay(7) || got.Age != 0 {
		t.Fatalf("a session admits the earliest new suspect: %+v", got)
	}
	if got := caForSession(known[:1], paperDay(19), paperDay(18), false); got.Known {
		t.Fatalf("a suspect known before the previous session is not new: %+v", got)
	}
}

// TestPaperSessionOfBarNeedsAPricedClose: a row dated on the session with a NULL
// close (stored as zero) is no bar, as the batch's barOn reads it. A priced close
// is a bar.
func TestPaperSessionOfBarNeedsAPricedClose(t *testing.T) {
	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		t.Fatal("no live version")
	}
	s := paperDay(18)
	meta, err := snapshot.EncodeMeta(snapshot.Meta{Name: "AAA", PricedSessions: 100})
	if err != nil {
		t.Fatal(err)
	}
	row := func(code string, c float64) snapshot.Row {
		return snapshot.Row{AsOf: s, BarDate: s, FeatureSet: snapshotFeatureSet, StockCode: code,
			OrdinaryFresh60: true, IsOrdinary: true, Meta: meta,
			Features: snapshot.Features{Bar: snapshot.Bar{O: 10, H: 10, L: 10, C: c, Adj: c, V: 1e6}}}
	}
	sess, err := paperSessionOf([]snapshot.Row{row("AAA", 0), row("BBB", 12)}, nil, engine.Regime{IndexCode: "XJO"},
		reg, s, prevTradingDay(s), 0, false, 0, 0, []string{"AAA"})
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]backtest.CodeSession{}
	for _, c := range sess.Codes {
		by[c.Code] = c
	}
	if by["AAA"].Bar != nil {
		t.Errorf("a NULL close on the session is no bar: %+v", by["AAA"].Bar)
	}
	if by["BBB"].Bar == nil || by["BBB"].Bar.Close != 12 {
		t.Errorf("a priced close is the session's bar: %+v", by["BBB"].Bar)
	}
}

// TestExDividendCountsTheFirstSessionOnOrAfterItsExDate: an ex-date on a weekend is
// credited on the next session, as the batch's dividendsBySession credits it, and
// on no session before.
func TestExDividendCountsTheFirstSessionOnOrAfterItsExDate(t *testing.T) {
	saturday := paperDay(14)
	divs := []features.Dividend{{ExDate: saturday, AmountPerShare: 0.4}}
	friday, monday := paperDay(13), paperDay(16)
	if got := exDividend(divs, prevTradingDay(friday), friday); got != 0 {
		t.Errorf("Friday before the weekend ex-date credits %v, want 0", got)
	}
	if got := exDividend(divs, friday, monday); got != 0.4 {
		t.Errorf("Monday credits %v, want 0.4", got)
	}
	if got := exDividend(divs, monday, paperDay(17)); got != 0 {
		t.Errorf("Tuesday after the credit credits %v, want 0", got)
	}
}

// TestPaperGuardOfIsTheSnapshotTheNextStepReads: the guard is two sessions before
// the next step of a track that has a checkpoint.
func TestPaperGuardOfIsTheSnapshotTheNextStepReads(t *testing.T) {
	asOf := paperDay(18)
	want := prevTradingDay(prevTradingDay(nextTradingDay(asOf)))
	if got := paperGuardOf(asOf, true, paperDay(2)); got != want {
		t.Errorf("guard = %s, want %s", got, want)
	}
}

// TestPaperConfigNeverKnowsALaterBar: the paper track's configuration carries no
// loaded-bar dates, so a stale exit can only be labelled delisted_exit. The batch
// labels a code suspended when a later bar exists in its loaded data; the paper
// track cannot see that data.
func TestPaperConfigNeverKnowsALaterBar(t *testing.T) {
	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		t.Fatal("no live version")
	}
	cfg, err := paperConfig(backtestTarget{Reg: reg, Recipe: *reg.Recipe})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LastLoaded != nil {
		t.Errorf("the paper track's config carries loaded-bar dates %v; a stale exit would then read suspended", cfg.LastLoaded)
	}
}
