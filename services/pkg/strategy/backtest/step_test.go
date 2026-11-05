package backtest

import (
	"math"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// base is the first session of every fixture. Session i is base plus i days.
var base = civil.Date{Year: 2025, Month: 3, Day: 3}

func dayAt(i int) civil.Date { return base.AddDays(i) }

// mkBar is a traded bar whose adjusted close equals its close (k = 1).
func mkBar(open, close float64) features.Bar {
	return features.Bar{
		Open:     open,
		High:     math.Max(open, close),
		Low:      math.Min(open, close),
		Close:    close,
		AdjClose: close,
		Volume:   1e6,
	}
}

// untradedBar is a row with zero volume: present, not traded.
func untradedBar(open, close float64) features.Bar {
	b := mkBar(open, close)
	b.Volume = 0
	return b
}

// codeAt is a code's session with the default signals: score 1, pivot 10,
// DV20 A$1bn (so capacity never binds and the spread is 5 bps).
func codeAt(code, status string, b features.Bar) CodeSession {
	return CodeSession{Code: code, Status: status, Bar: &b, Score: 1, Pivot: 10, DV20: 1e9}
}

func sessionAt(i int, codes ...CodeSession) Session {
	return Session{Date: dayAt(i), Index: i, Codes: codes}
}

func testConfig() Config {
	return Config{
		Capital:          100000,
		WeightPct:        10,
		MaxPositions:     10,
		CapacityPctDV20:  5,
		Costs:            houseCosts(),
		CooldownSessions: 10,
		Price4dpFrom:     base,
	}
}

func near(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Fatalf("%s = %.9f, want %.9f (tol %g)", name, got, want, tol)
	}
}

func hasEvent(st *State, kind, reason string) bool {
	for _, e := range st.Events() {
		if e.Kind == kind && e.Reason == reason {
			return true
		}
	}
	return false
}

func hasFlag(flags []string, f string) bool {
	for _, x := range flags {
		if x == f {
			return true
		}
	}
	return false
}

func recordAt(t *testing.T, st *State, index int) Record {
	t.Helper()
	for _, r := range st.Records() {
		if r.Index == index {
			return r
		}
	}
	t.Fatalf("no record for session %d", index)
	return Record{}
}

// enter runs sessions 0 (setup), 1 (triggered, the candidate) and 2 (the fill
// session, with the given bar), leaving the position open on session 2.
func enter(t *testing.T, cfg Config, fill features.Bar) *State {
	t.Helper()
	st := NewState(cfg)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, fill)))
	return st
}

func TestEntryFillsAtNextTradedOpen(t *testing.T) {
	st := enter(t, testConfig(), mkBar(10.5, 10.6))
	pos := st.positions["AAA"]
	if pos == nil {
		t.Fatal("no position after the fill session")
	}
	if pos.entryDate != dayAt(2) {
		t.Fatalf("entry date %v, want session 2", pos.entryDate)
	}
	near(t, "entry price", pos.entryPL, 10.5, 1e-12)
	// 10% of A$100,000 at 10.5; brokerage is the A$10 floor, spread 5 bps.
	near(t, "qty", pos.qty, 10000/10.5, 1e-9)
	near(t, "entry fee", pos.entryFee, 15, 1e-9)
	near(t, "cash after entry", st.cash, 100000-10000-15, 1e-9)
	if !hasEvent(st, EventEntryFilled, "") {
		t.Fatal("no entry_filled event")
	}
}

func TestEntryCancelledWhenUntraded(t *testing.T) {
	st := enter(t, testConfig(), untradedBar(10.5, 10.5))
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("an untraded fill opened a position")
	}
	if !hasEvent(st, EventEntryCancelled, CancelUntraded) {
		t.Fatal("no cancelled_untraded event")
	}
}

func TestEntryCancelledAboveTheGapLimit(t *testing.T) {
	cfg := testConfig()
	limit := 5.0
	cfg.MaxAbovePivotPct = &limit
	// Pivot is 10, so the limit is 10.5. An open of 10.6 is above it.
	st := enter(t, cfg, mkBar(10.6, 10.6))
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("an entry above the gap limit filled")
	}
	if !hasEvent(st, EventEntryCancelled, CancelGap) {
		t.Fatal("no cancelled_gap event")
	}
}

func TestEntryCancelledWhenCashCannotPayTheMinimumFee(t *testing.T) {
	cfg := testConfig()
	cfg.Capital = 5
	cfg.WeightPct = 100
	st := enter(t, cfg, mkBar(10, 10))
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("an entry costing more than the cash filled")
	}
	if !hasEvent(st, EventEntryCancelled, CancelCash) {
		t.Fatal("no cancelled_cash event")
	}
}

func TestEntryCashIsCappedNotOverdrawn(t *testing.T) {
	cfg := testConfig()
	cfg.Capital = 1000
	cfg.WeightPct = 100
	st := enter(t, cfg, mkBar(10, 10))
	// Notional 989.5 plus its fee of 10.49475 leaves 0.00525 of the 1000.
	near(t, "cash after a cash-limited entry", st.cash, 0.00525, 1e-6)
	if st.cash < 0 {
		t.Fatalf("cash went negative: %v", st.cash)
	}
}

func TestCapacityCapsTheNotional(t *testing.T) {
	cfg := testConfig()
	st := NewState(cfg)
	thin := codeAt("AAA", statusTriggered, mkBar(10, 10))
	thin.DV20 = 100000 // 5% of A$100k is A$5,000, below the A$10,000 weight
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, thin))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	pos := st.positions["AAA"]
	if pos == nil {
		t.Fatal("no position")
	}
	near(t, "capacity-capped qty", pos.qty, 500, 1e-9)
	if !pos.flags[FlagCapacityCapped] {
		t.Fatal("capacity_capped not set")
	}
}

func TestFillFallsBackToCloseOnZeroOpen(t *testing.T) {
	fill := features.Bar{Open: 0, High: 10.4, Low: 10.4, Close: 10.4, AdjClose: 10.4, Volume: 1e6}
	st := enter(t, testConfig(), fill)
	pos := st.positions["AAA"]
	if pos == nil {
		t.Fatal("no position")
	}
	near(t, "fallback entry price", pos.entryPL, 10.4, 1e-12)
	if !pos.flags[FlagFallbackClose] {
		t.Fatal("fallback_close not set")
	}
}

func TestPivotExitWaitsForATradedOpen(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9.5)))) // close below the pivot of 10
	if _, queued := st.exits["AAA"]; !queued {
		t.Fatal("a close below the pivot did not queue an exit")
	}
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, untradedBar(9.8, 9.8))))
	if _, ok := st.positions["AAA"]; !ok {
		t.Fatal("an untraded bar closed the position")
	}
	Step(st, sessionAt(5, codeAt("AAA", statusTriggered, mkBar(9.8, 9.9))))
	trades := st.Finish()
	if len(trades) != 1 {
		t.Fatalf("got %d trades, want 1", len(trades))
	}
	tr := trades[0]
	if tr.ExitReason != ReasonPivotStop || tr.ExitDate != dayAt(5) {
		t.Fatalf("exit %s on %v, want pivot_stop on session 5", tr.ExitReason, tr.ExitDate)
	}
	near(t, "exit price", tr.ExitPrice, 9.8, 1e-12)
	if !hasFlag(tr.Flags, FlagDelayedExit) {
		t.Fatalf("delayed_exit missing from flags %v", tr.Flags)
	}
}

func TestTimeStopFillsAfterTheNthSession(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitTimeStop, Sessions: 3}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 10.1))))
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(10, 10.2))))
	Step(st, sessionAt(5, codeAt("AAA", statusTriggered, mkBar(10, 10.3)))) // 3 sessions after entry
	Step(st, sessionAt(6, codeAt("AAA", statusTriggered, mkBar(10.4, 10.4))))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonTimeStop || tr.ExitDate != dayAt(6) {
		t.Fatalf("exit %s on %v, want time_stop on session 6", tr.ExitReason, tr.ExitDate)
	}
	if tr.SessionsHeld != 4 {
		t.Fatalf("sessions held %d, want 4", tr.SessionsHeld)
	}
}

func TestStopLossExit(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitStopLoss, Pct: 8}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9.1)))) // 9.1 <= 10 x 0.92 = 9.2
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(9, 9.05))))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonStopLoss {
		t.Fatalf("exit reason %s, want stop_loss", tr.ExitReason)
	}
	near(t, "stop-loss fill", tr.ExitPrice, 9, 1e-12)
}

func TestSMAExitOnOneClose(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitCloseBelowSMA, SMA: 50}}
	st := enter(t, cfg, mkBar(10, 10))
	c3 := codeAt("AAA", statusTriggered, mkBar(10, 10))
	c3.SMA50 = 9.5
	Step(st, sessionAt(3, c3))
	c4 := codeAt("AAA", statusTriggered, mkBar(9.4, 9.4))
	c4.SMA50 = 9.5
	Step(st, sessionAt(4, c4)) // close 9.4 below SMA 9.5
	Step(st, sessionAt(5, codeAt("AAA", statusTriggered, mkBar(9.3, 9.3))))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonSMAStop || tr.ExitDate != dayAt(5) {
		t.Fatalf("exit %s on %v, want sma_stop on session 5", tr.ExitReason, tr.ExitDate)
	}
}

func TestStatusExitNeedsConsecutiveSessions(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitStatusFalls, Statuses: []string{"watch", "none"}, Sessions: 2}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(4, codeAt("AAA", "watch", mkBar(10, 10))))
	if _, queued := st.exits["AAA"]; queued {
		t.Fatal("one session below the status queued an exit; two were needed")
	}
	Step(st, sessionAt(5, codeAt("AAA", "none", mkBar(10, 10))))
	Step(st, sessionAt(6, codeAt("AAA", "none", mkBar(10, 10))))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonStatusExit {
		t.Fatalf("exit reason %s, want status_exit", tr.ExitReason)
	}
}

func TestStaleExitIsDelistedOrSuspended(t *testing.T) {
	cases := []struct {
		name       string
		lastLoaded civil.Date
		want       string
	}{
		// The last loaded bar is the last close: the code never trades again.
		{"delisted", dayAt(3), ReasonDelisted},
		// A later bar exists: a suspension.
		{"suspended", dayAt(50), ReasonSuspended},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testConfig()
			cfg.StaleExitSessions = 3
			cfg.LastLoaded = map[string]civil.Date{"AAA": tc.lastLoaded}
			st := enter(t, cfg, mkBar(10, 10))
			Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 10))))
			Step(st, sessionAt(4))
			Step(st, sessionAt(5))
			if _, ok := st.positions["AAA"]; !ok {
				t.Fatal("the position closed before the stale run ended")
			}
			Step(st, sessionAt(6))
			tr := st.Finish()[0]
			if tr.ExitReason != tc.want || tr.ExitDate != dayAt(6) {
				t.Fatalf("exit %s on %v, want %s on session 6", tr.ExitReason, tr.ExitDate, tc.want)
			}
			near(t, "stale exit price", tr.ExitPrice, 10, 1e-12)
			if !hasFlag(tr.Flags, FlagStaleMarks) {
				t.Fatalf("stale_marks missing from flags %v", tr.Flags)
			}
		})
	}
}

func TestCorporateActionExitClosesAtThePreSuspectClose(t *testing.T) {
	st := enter(t, testConfig(), mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 11))))
	// Bar 4 is the suspect: a -55% gap. It is known on session 6.
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(11, 5))))
	Step(st, sessionAt(5, codeAt("AAA", statusTriggered, mkBar(5, 5))))
	c6 := codeAt("AAA", statusTriggered, mkBar(5, 5))
	c6.CA = CASuspect{Known: true, SuspectDate: dayAt(4)}
	Step(st, sessionAt(6, c6))
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("the position survived the corporate-action exclusion")
	}
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonCorporateAction || tr.ExitDate != dayAt(6) {
		t.Fatalf("exit %s on %v, want corporate_action_exit on session 6", tr.ExitReason, tr.ExitDate)
	}
	near(t, "exclusion price", tr.ExitPrice, 11, 1e-12)
}

func TestCorporateActionLeavesAPositionEnteredOnTheSuspectBar(t *testing.T) {
	st := NewState(testConfig())
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10)))) // candidate; fills on 3
	c3 := codeAt("AAA", statusTriggered, mkBar(10, 4))
	c3.CA = CASuspect{Known: true, SuspectDate: dayAt(3)}
	Step(st, sessionAt(3, c3))
	if _, ok := st.positions["AAA"]; !ok {
		t.Fatal("a position entered on the suspect bar was closed by the exclusion")
	}
}

func TestCooldownBlocksReentry(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9.5))))
	Step(st, sessionAt(4, codeAt("AAA", "setup", mkBar(9.6, 9.6)))) // exit fills on 4
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("exit did not fill on session 4")
	}
	Step(st, sessionAt(5, codeAt("AAA", statusTriggered, mkBar(9.6, 9.6))))
	if len(st.entries) != 0 {
		t.Fatal("a re-trigger one session after the exit was scheduled")
	}
	for i := 6; i <= 13; i++ {
		Step(st, sessionAt(i, codeAt("AAA", "setup", mkBar(9.6, 9.6))))
	}
	Step(st, sessionAt(14, codeAt("AAA", statusTriggered, mkBar(9.6, 9.6)))) // 10 sessions after the exit
	if len(st.entries) != 1 || st.entries[0].code != "AAA" {
		t.Fatalf("re-entry after the cooldown not scheduled: %+v", st.entries)
	}
}

func TestCorporateActionBlocksNewEntriesForSixtySessions(t *testing.T) {
	st := NewState(testConfig())
	c1 := codeAt("AAA", "setup", mkBar(10, 10))
	c1.CA = CASuspect{Known: true, SuspectDate: dayAt(1)}
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, c1))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	if len(st.entries) != 0 {
		t.Fatal("a candidate one session after a corporate-action suspect was scheduled")
	}
	for i := 3; i <= 63; i++ {
		Step(st, sessionAt(i, codeAt("AAA", "setup", mkBar(10, 10))))
	}
	Step(st, sessionAt(64, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	if len(st.entries) != 1 {
		t.Fatal("entry 63 sessions after the suspect was still blocked")
	}
}

func TestFreshRuleSkipsATradedBreakout(t *testing.T) {
	cfg := testConfig()
	cfg.CooldownSessions = 0
	cfg.NewBreakoutOnly = true
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitStopLoss, Pct: 8}}
	st := NewState(cfg)
	brk := dayAt(1)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	trig := codeAt("AAA", statusTriggered, mkBar(10, 10))
	trig.BreakoutDate = brk
	Step(st, sessionAt(1, trig))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9))))
	Step(st, sessionAt(4, codeAt("AAA", "setup", mkBar(9, 9))))
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("the stop did not close the position")
	}
	again := codeAt("AAA", statusTriggered, mkBar(9, 9))
	again.BreakoutDate = brk
	Step(st, sessionAt(5, codeAt("AAA", "setup", mkBar(9, 9))))
	Step(st, sessionAt(6, again))
	if len(st.entries) != 0 {
		t.Fatal("a breakout already traded in this code was re-entered")
	}
	Step(st, sessionAt(7, codeAt("AAA", "setup", mkBar(9, 9))))
	fresh := codeAt("AAA", statusTriggered, mkBar(9, 9))
	fresh.BreakoutDate = dayAt(8)
	Step(st, sessionAt(8, fresh))
	if len(st.entries) != 1 {
		t.Fatal("a new breakout date was not scheduled")
	}
}

func TestFirstSessionTriggeredDoesNotEnter(t *testing.T) {
	st := NewState(testConfig())
	Step(st, sessionAt(0, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	if len(st.entries) != 0 {
		t.Fatal("a code triggered on the first session was scheduled without a prior status")
	}
}

func TestCashAccruesTheRBARateOverAYear(t *testing.T) {
	st := NewState(testConfig())
	for i := 0; i < TradingDaysPerYear; i++ {
		Step(st, Session{Date: dayAt(i), Index: i, CashRate: 0.04})
	}
	near(t, "cash after a year at 4%", st.Equity(), 104000, 1e-6)
}

func TestDividendCreditedOnAnUnadjustedExDate(t *testing.T) {
	cfg := testConfig()
	st := enter(t, cfg, mkBar(10, 10))
	ex := codeAt("AAA", statusTriggered, mkBar(10, 9.5))
	ex.Dividend = 0.2
	Step(st, sessionAt(3, ex))
	pos := st.positions["AAA"]
	near(t, "dividend credited", pos.dividends, 0.2*pos.qty, 1e-9)
	near(t, "cash after the dividend", st.cash, 89985+0.2*pos.qty, 1e-9)
}

func TestDividendNotCreditedWhenVendorAdjusted(t *testing.T) {
	st := enter(t, testConfig(), mkBar(10, 10))
	ex := codeAt("AAA", statusTriggered, features.Bar{Open: 10, High: 10, Low: 9.5, Close: 9.5, AdjClose: 9.69, Volume: 1e6})
	ex.Dividend = 0.2
	Step(st, sessionAt(3, ex))
	pos := st.positions["AAA"]
	if pos.dividends != 0 {
		t.Fatalf("an adjusted ex-date credited %v in cash", pos.dividends)
	}
	near(t, "multiplier after the vendor step", st.codeState("AAA").mult, 1.02, 1e-9)
}

// payerScenario is a 2-dp A$1.49 dividend payer. The vendor's adjusted close is
// stored to cents as 1.47 on both bars, so the step the vendor did not apply
// is a rounding artefact of about 0.7%.
func payerScenario(t *testing.T, price4dpFrom civil.Date) *State {
	t.Helper()
	cfg := testConfig()
	cfg.Price4dpFrom = price4dpFrom
	st := NewState(cfg)
	cents := func(open, close float64) features.Bar {
		return features.Bar{Open: open, High: math.Max(open, close), Low: math.Min(open, close), Close: close, AdjClose: 1.47, Volume: 1e6}
	}
	Step(st, sessionAt(0, codeAt("AAA", "setup", cents(1.49, 1.49))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, cents(1.49, 1.49))))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, cents(1.49, 1.49))))
	ex := codeAt("AAA", statusTriggered, cents(1.5, 1.5))
	ex.Dividend = 0.05
	Step(st, sessionAt(3, ex))
	return st
}

func TestTwoDPPayerStaysTotalReturn(t *testing.T) {
	// Date 3 is before the 4-decimal date, so the cents quantum applies and the
	// tolerance is wide enough to take the 0.67% step as rounding.
	st := payerScenario(t, dayAt(10))
	pos := st.positions["AAA"]
	if pos.flags[FlagPriceReturnOnly] {
		t.Fatal("a 2-dp payer priced A$1-2 fell back to price return")
	}
	// The bar is cash-credited, so its step is not applied to the multiplier:
	// the dividend is the adjustment for it, and the step would count it twice.
	near(t, "multiplier", st.codeState("AAA").mult, 1, 1e-12)
	near(t, "dividend credited in cash", pos.dividends, 0.05*pos.qty, 1e-9)
}

func TestQuantumDecidesTheSameStepAsPriceReturn(t *testing.T) {
	// The same bars with the 4-decimal quantum: the step is wider than the
	// tolerance, so the bar falls back to price return and the multiplier holds.
	st := payerScenario(t, base)
	pos := st.positions["AAA"]
	if !pos.flags[FlagPriceReturnOnly] {
		t.Fatal("the 4-decimal quantum did not treat the step as price return")
	}
	near(t, "multiplier", st.codeState("AAA").mult, 1, 1e-12)
}

func TestKArtefactChangesOnlyItsOwnBar(t *testing.T) {
	st := enter(t, testConfig(), mkBar(10, 10))
	before := recordAt(t, st, 2).Equity
	spike := features.Bar{Open: 10, High: 10, Low: 10, Close: 10, AdjClose: 13, Volume: 1e6}
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, spike)))
	if got := st.codeState("AAA").mult; got != 1 {
		t.Fatalf("multiplier after a 30%% artefact = %v, want 1", got)
	}
	near(t, "equity on the artefact bar", recordAt(t, st, 3).Equity, before, 1e-9)
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	if got := st.codeState("AAA").mult; got != 1 {
		t.Fatalf("the artefact reversal moved the multiplier to %v", got)
	}
	Step(st, sessionAt(5, codeAt("AAA", statusTriggered, mkBar(10, 11))))
	near(t, "multiplier after a clean bar", st.codeState("AAA").mult, 1, 1e-12)
}

// fixedPath is one scripted round trip with one unadjusted cash dividend and no
// cash constraint, so every fill is the same whatever the costs.
func fixedPath(t *testing.T, multiplier float64) *State {
	t.Helper()
	cfg := testConfig()
	cfg.Costs.Multiplier = multiplier
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
	st := NewState(cfg)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10.2))))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10.2, 10.6))))
	div := codeAt("AAA", statusTriggered, mkBar(10.6, 11))
	div.Dividend = 0.1 // an unadjusted ex-date on the path, credited in cash
	Step(st, sessionAt(3, div))
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(11, 9.5))))
	Step(st, sessionAt(5, codeAt("AAA", statusTriggered, mkBar(9.4, 9.4))))
	return st
}

func TestCostsOnAFixedFillPath(t *testing.T) {
	one := fixedPath(t, 1)
	two := fixedPath(t, 2)
	t1, t2 := one.Finish(), two.Finish()
	if len(t1) != 1 || len(t2) != 1 {
		t.Fatalf("trade counts %d and %d, want 1 and 1", len(t1), len(t2))
	}
	for name, tr := range map[string]Trade{"multiplier 1": t1[0], "multiplier 2": t2[0]} {
		if tr.Net > tr.Gross {
			t.Fatalf("%s: net %v above gross %v", name, tr.Net, tr.Gross)
		}
	}
	if t2[0].Net > t1[0].Net {
		t.Fatalf("doubling costs raised the net return: %v > %v", t2[0].Net, t1[0].Net)
	}
	if t1[0].Dividends <= 0 {
		t.Fatal("the fixed path carries no cash dividend, so the gross and net gate is not exercised")
	}
	// The replay is only a cost comparison if both runs fill the same trade.
	a, b := t1[0], t2[0]
	if a.EntryDate != b.EntryDate || a.ExitDate != b.ExitDate || a.Qty != b.Qty ||
		a.EntryFill != b.EntryFill || a.ExitFill != b.ExitFill || a.Dividends != b.Dividends {
		t.Fatalf("costs changed the fill path: %+v against %+v", a, b)
	}
	if !(b.Fees > a.Fees) {
		t.Fatalf("doubling costs did not raise the fees: %v against %v", b.Fees, a.Fees)
	}
	if !(two.Equity() <= one.Equity()) {
		t.Fatalf("final equity at 2x costs %v above 1x %v", two.Equity(), one.Equity())
	}
}

func TestExitFillsAtCloseOnZeroOpen(t *testing.T) {
	// The pivot stop fires on session 3's close; session 4 opens at zero, so the
	// exit fills at that session's close and is flagged.
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9.5))))
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, features.Bar{Open: 0, High: 9.8, Low: 9.8, Close: 9.8, AdjClose: 9.8, Volume: 1e6})))
	trades := st.Finish()
	if len(trades) != 1 {
		t.Fatalf("trades %d, want one closed trade", len(trades))
	}
	tr := trades[0]
	if tr.OpenAtEnd || tr.ExitDate != dayAt(4) {
		t.Fatalf("exit on %v open-at-end %v, want a closed exit on session 4", tr.ExitDate, tr.OpenAtEnd)
	}
	near(t, "exit fill at the close", tr.ExitFill, 9.8, 1e-12)
	if !hasFlag(tr.Flags, FlagFallbackClose) {
		t.Fatalf("exit at a zero open not flagged fallback_close: %v", tr.Flags)
	}
}

func TestSMA200ExitNeedsFiveClosesBelowTheLongAverage(t *testing.T) {
	// Close 10 is above SMA50 (5) and below SMA200 (11). The 200-session rule
	// counts consecutive closes below SMA200 and must not read SMA50: it fires on
	// the fifth such close, session 7, and fills at session 8's open.
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitCloseBelowSMA, SMA: 200, Sessions: 5}}
	st := enter(t, cfg, mkBar(10, 10))
	bar := func() CodeSession {
		c := codeAt("AAA", statusTriggered, mkBar(10, 10))
		c.SMA50, c.SMA200 = 5, 11
		return c
	}
	for i := 3; i <= 6; i++ {
		Step(st, sessionAt(i, bar()))
		if _, queued := st.exits["AAA"]; queued {
			t.Fatalf("exit queued after %d closes below SMA200, want five", i-2)
		}
	}
	Step(st, sessionAt(7, bar()))
	if px, queued := st.exits["AAA"]; !queued || px.reason != ReasonSMAStop {
		t.Fatalf("no SMA200 exit queued on the fifth close below SMA200: %+v queued %v", px, queued)
	}
	Step(st, sessionAt(8, bar()))
	trades := st.Finish()
	if len(trades) != 1 || trades[0].ExitReason != ReasonSMAStop {
		t.Fatalf("trades %+v, want one sma_stop exit", trades)
	}
	if trades[0].ExitSignalDate != dayAt(7) || trades[0].ExitDate != dayAt(8) {
		t.Fatalf("exit signal %v filled %v, want signal session 7 and fill session 8",
			trades[0].ExitSignalDate, trades[0].ExitDate)
	}
}

func TestOpenAtEndIsMarkedAndExcluded(t *testing.T) {
	st := enter(t, testConfig(), mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 12))))
	trades := st.Finish()
	if len(trades) != 1 || !trades[0].OpenAtEnd || trades[0].ExitReason != ReasonOpenAtEnd {
		t.Fatalf("open position not reported as open at end: %+v", trades)
	}
	if !trades[0].ExitSignalDate.IsZero() {
		t.Fatalf("open trade with no pending exit reports exit signal %v", trades[0].ExitSignalDate)
	}
}

func TestUpJumpSuspectExitsOnItsOwnBar(t *testing.T) {
	// A 10x consolidation known on the bar it occurs: the position entered
	// before it closes at the pre-jump close, on that same session.
	st := enter(t, testConfig(), mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	jump := codeAt("AAA", statusTriggered, mkBar(100, 100))
	jump.CA = CASuspect{Known: true, SuspectDate: dayAt(4)}
	Step(st, sessionAt(4, jump))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonCorporateAction || tr.ExitDate != dayAt(4) {
		t.Fatalf("exit %s on %v, want corporate_action_exit on session 4", tr.ExitReason, tr.ExitDate)
	}
	near(t, "exit at the pre-jump close", tr.ExitPrice, 10, 1e-12)
}

func TestStepIsDeterministic(t *testing.T) {
	run := func() float64 {
		cfg := testConfig()
		cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
		st := NewState(cfg)
		a := codeAt("BBB", "setup", mkBar(5, 5))
		b := codeAt("AAA", "setup", mkBar(7, 7))
		Step(st, sessionAt(0, b, a))
		a.Status, b.Status = statusTriggered, statusTriggered
		a.Score, b.Score = 2, 2
		Step(st, sessionAt(1, b, a))
		Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(7, 7)), codeAt("BBB", statusTriggered, mkBar(5, 5))))
		return st.Equity()
	}
	if x, y := run(), run(); x != y {
		t.Fatalf("two identical runs disagree: %v and %v", x, y)
	}
}

// shortCodeBar is a traded bar that is cash-credited or stepped by the caller:
// its adjusted close is given separately from its close.
func shortCodeBar(open, close, adj float64) features.Bar {
	return features.Bar{Open: open, High: math.Max(open, close), Low: math.Min(open, close), Close: close, AdjClose: adj, Volume: 1e6}
}

func TestDividendCreditScalesWithTheMultiplier(t *testing.T) {
	// The first session's close is 10 on an adjusted level of 9, so the
	// multiplier is 1/0.9 before the entry. The position holds 900 units on the
	// P&L basis, 10,000 of notional at 11.11. An unadjusted 50c ex-date whose
	// close falls by 50c must leave equity unchanged: the 50c is credited on
	// the 900 shares actually held, not on the 900 units.
	st := NewState(testConfig())
	Step(st, sessionAt(0, codeAt("AAA", "setup", shortCodeBar(9, 10, 9))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	pos := st.positions["AAA"]
	if pos == nil {
		t.Fatal("no position")
	}
	near(t, "multiplier before the ex-date", st.codeState("AAA").mult, 1/0.9, 1e-9)
	near(t, "units on the P&L basis", pos.qty, 900, 1e-6)
	before := recordAt(t, st, 2).Equity
	ex := codeAt("AAA", statusTriggered, mkBar(9.5, 9.5))
	ex.Dividend = 0.5
	Step(st, sessionAt(3, ex))
	near(t, "dividend on 900 shares", pos.dividends, 500, 1e-6)
	near(t, "equity across an unadjusted ex-date", recordAt(t, st, 3).Equity, before, 1e-6)
}

func TestBuyerAtAnExDateOpenIsNotPaid(t *testing.T) {
	// The buyer's fill is the ex-date open, so the register is the one at the
	// previous close and the buyer was not on it.
	st := NewState(testConfig())
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	fill := codeAt("AAA", statusTriggered, mkBar(9.5, 9.5))
	fill.Dividend = 0.2
	Step(st, sessionAt(2, fill))
	pos := st.positions["AAA"]
	if pos == nil {
		t.Fatal("no position")
	}
	if pos.dividends != 0 {
		t.Fatalf("a buyer at the ex-date open was credited %v", pos.dividends)
	}
	near(t, "cash after the buy", st.cash, 100000-10000-15, 1e-9)
}

func TestSellerAtAnExDateOpenIsPaid(t *testing.T) {
	// The seller held the shares at the previous close, so the dividend is paid
	// on the trade that exits at the ex-date open.
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9))))
	ex := codeAt("AAA", statusTriggered, mkBar(9.5, 9.5))
	ex.Dividend = 0.5
	Step(st, sessionAt(4, ex))
	trades := st.Finish()
	if len(trades) != 1 {
		t.Fatalf("got %d trades, want 1", len(trades))
	}
	tr := trades[0]
	if tr.ExitReason != ReasonPivotStop || tr.ExitDate != dayAt(4) {
		t.Fatalf("exit %s on %v, want pivot_stop on session 4", tr.ExitReason, tr.ExitDate)
	}
	near(t, "dividend on the exiting trade", tr.Dividends, 500, 1e-6)
	// Proceeds 9,500 less the exit fee of 14.75 (brokerage floor 10 and 5 bps
	// spread), on top of 89,985 cash after the entry and 500 of dividend.
	near(t, "cash after the exit", st.cash, 89985+500+9500-14.75, 1e-6)
}

func TestQueuedExitDoesNotFillOnAnUpJumpSuspectBar(t *testing.T) {
	// The pivot stop is queued at session 3's close. Session 4 is a 10x
	// consolidation known on its own bar: the queued exit must not fill at the
	// jumped open. The position closes at the pre-suspect close (9) instead.
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9))))
	jump := codeAt("AAA", statusTriggered, mkBar(100, 100))
	jump.CA = CASuspect{Known: true, SuspectDate: dayAt(4)}
	Step(st, sessionAt(4, jump))
	trades := st.Finish()
	if len(trades) != 1 {
		t.Fatalf("got %d trades, want 1", len(trades))
	}
	tr := trades[0]
	if tr.ExitReason != ReasonCorporateAction || tr.ExitDate != dayAt(4) {
		t.Fatalf("exit %s on %v, want corporate_action_exit on session 4", tr.ExitReason, tr.ExitDate)
	}
	near(t, "exit at the pre-suspect close", tr.ExitPrice, 9, 1e-12)
	near(t, "exit fill on the signal basis", tr.ExitFill, 9, 1e-12)
	if tr.Net > 0 {
		t.Fatalf("a position marked down into the exclusion has net %v", tr.Net)
	}
}

// caSetup runs sessions 0..last as setup, with a corporate-action suspect known
// on each session in known and SuspectDate set to that session.
func caSetup(t *testing.T, st *State, last int, known ...int) {
	t.Helper()
	isKnown := map[int]bool{}
	for _, k := range known {
		isKnown[k] = true
	}
	for i := 0; i <= last; i++ {
		c := codeAt("AAA", "setup", mkBar(10, 10))
		if isKnown[i] {
			c.CA = CASuspect{Known: true, SuspectDate: dayAt(i)}
		}
		Step(st, sessionAt(i, c))
	}
}

func TestEveryCorporateActionSuspectRearmsTheEntryBlock(t *testing.T) {
	// Suspects known on sessions 1 and 100. A candidate on session 101 is within
	// 60 sessions of the second suspect, so it must not be scheduled.
	st := NewState(testConfig())
	caSetup(t, st, 100, 1, 100)
	Step(st, sessionAt(101, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	if len(st.entries) != 0 {
		t.Fatal("a candidate 1 session after a second corporate-action suspect was scheduled")
	}
}

func TestCorporateActionBlockBoundary(t *testing.T) {
	// The block covers the suspect's session and the 60 sessions after it: a
	// candidate on session 61 is blocked, one on session 62 is not.
	t.Run("61 sessions after is blocked", func(t *testing.T) {
		st := NewState(testConfig())
		caSetup(t, st, 60, 1)
		Step(st, sessionAt(61, codeAt("AAA", statusTriggered, mkBar(10, 10))))
		if len(st.entries) != 0 {
			t.Fatal("a candidate 60 sessions after the suspect was scheduled")
		}
	})
	t.Run("62 sessions after is admitted", func(t *testing.T) {
		st := NewState(testConfig())
		caSetup(t, st, 61, 1)
		Step(st, sessionAt(62, codeAt("AAA", statusTriggered, mkBar(10, 10))))
		if len(st.entries) != 1 {
			t.Fatal("a candidate 61 sessions after the suspect was still blocked")
		}
	})
}

func TestSmallVendorAdjustedDividendIsCountedOnce(t *testing.T) {
	// A 2c dividend on a A$1.50 payer. The vendor stored the history adjusted,
	// so the ex-date's step is ln(1.5/1.48), 1.34%: under the cents-era tolerance
	// (about 1.45%) it reads as rounding. Either way the equity on the ex-date
	// must not move: the dividend is counted once, in the price basis or in cash.
	for name, from := range map[string]civil.Date{"4-decimal era": base, "cents era": dayAt(10)} {
		t.Run(name, func(t *testing.T) {
			cfg := testConfig()
			cfg.Price4dpFrom = from
			st := NewState(cfg)
			prev := shortCodeBar(1.5, 1.5, 1.48)
			Step(st, sessionAt(0, codeAt("AAA", "setup", prev)))
			Step(st, sessionAt(1, codeAt("AAA", statusTriggered, prev)))
			Step(st, sessionAt(2, codeAt("AAA", statusTriggered, prev)))
			before := recordAt(t, st, 2).Equity
			ex := codeAt("AAA", statusTriggered, shortCodeBar(1.48, 1.48, 1.48))
			ex.Dividend = 0.02
			Step(st, sessionAt(3, ex))
			near(t, "equity across the ex-date", recordAt(t, st, 3).Equity, before, 1e-6)
		})
	}
}

func TestClassifyBarTolerance(t *testing.T) {
	// Prices at 10 with unit adjustment ratios, so the step is the ratio's log.
	prev := features.Bar{Close: 10, AdjClose: 10}
	cases := []struct {
		name        string
		rk          float64
		date, from  civil.Date
		totalReturn bool
		unadjusted  bool
	}{
		{"noise within tolerance", -0.00101, base, base, true, true},
		{"just above tolerance is an adjustment", 0.002, base, base, true, false},
		{"fall beyond tolerance is price return and cash", -0.05, base, base, false, true},
		{"rise over 15% is price return", 0.15, base, base, false, false},
		{"cents era widens the tolerance", 0.002, dayAt(0), dayAt(10), true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Both bars sit on the case's session, so they share its quantum.
			prev := prev
			prev.Date = tc.date
			cur := features.Bar{Date: tc.date, Close: 10, AdjClose: 10 * math.Exp(tc.rk)}
			b := ClassifyBar(prev, cur, true, tc.date, tc.from)
			if b.TotalReturn != tc.totalReturn || b.Unadjusted != tc.unadjusted {
				t.Fatalf("total return %v unadjusted %v, want %v and %v (rk %.5f tol %.5f)",
					b.TotalReturn, b.Unadjusted, tc.totalReturn, tc.unadjusted, b.RK, b.Tol)
			}
		})
	}
}

func TestFirstFourDecimalBarPricesThePreviousCentsRounding(t *testing.T) {
	// The previous bar is cents-rounded (1.50 close, 1.47 adjusted); the first
	// four-decimal bar carries its exact adjusted close. Its step of about +0.33%
	// is the previous bar's rounding, not a vendor adjustment, so the bar is
	// unadjusted and a cash dividend on it is credited. A tolerance taken from
	// this bar's quantum alone (about 0.0011) would read it as an adjustment.
	from := dayAt(10)
	prev := features.Bar{Date: dayAt(9), Close: 1.5, AdjClose: 1.47}
	cur := features.Bar{Date: from, Close: 1.5, AdjClose: 1.4749}
	b := ClassifyBar(prev, cur, true, from, from)
	if !b.Unadjusted {
		t.Fatalf("the rounding step was read as a vendor adjustment (rk %.5f tol %.5f)", b.RK, b.Tol)
	}
	if !b.TotalReturn {
		t.Fatalf("the rounding step fell outside total return (rk %.5f tol %.5f)", b.RK, b.Tol)
	}
	if b.Tol < 0.0075 {
		t.Fatalf("tolerance %.5f ignores the previous bar's cents rounding", b.Tol)
	}
}

func TestToleranceFloorAloneKeepsAStepTotalReturn(t *testing.T) {
	// With the 4-decimal quantum the tolerance is 0.001 plus about 0.00002, so
	// the 0.001 floor carries a step of -0.00101 to total return.
	prev := features.Bar{Close: 10, AdjClose: 10}
	cur := features.Bar{Close: 10, AdjClose: 10 * math.Exp(-0.00101)}
	b := ClassifyBar(prev, cur, true, base, base)
	if !b.TotalReturn {
		t.Fatalf("a step within the floor was price return (tol %.6f)", b.Tol)
	}
	if b.Tol < toleranceFloor {
		t.Fatalf("tolerance %v below the floor", b.Tol)
	}
}

func TestEntryBlockedWhileAnEarlierPositionMoved(t *testing.T) {
	// AAA is bought at 10 and closes session 4 at 12. Its equity of 101,985 on
	// session 4 is the base for BBB's sizing on the next session: 10% of it.
	st := NewState(testConfig())
	for i := 0; i <= 3; i++ {
		a := codeAt("AAA", "setup", mkBar(10, 10))
		b := codeAt("BBB", "setup", mkBar(20, 20))
		if i == 2 {
			a.Status = statusTriggered
		}
		if i == 3 {
			bar := mkBar(10, 12)
			a.Bar = &bar // fills AAA at 10 on session 3, closes at 12
		}
		Step(st, sessionAt(i, b, a))
	}
	if _, ok := st.positions["AAA"]; !ok {
		t.Fatal("AAA not held")
	}
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(12, 12)), codeAt("BBB", statusTriggered, mkBar(20, 20))))
	near(t, "equity on session 4", st.Equity(), 89985+1000*12, 1e-6)
	Step(st, sessionAt(5, codeAt("AAA", statusTriggered, mkBar(12, 12)), codeAt("BBB", statusTriggered, mkBar(20, 20))))
	pos := st.positions["BBB"]
	if pos == nil {
		t.Fatal("BBB not filled on session 5")
	}
	near(t, "BBB notional is 10% of equity on session 4", pos.qty*pos.entryPL, 0.1*(89985+1000*12), 1e-6)
}

func TestTimeStopDecidedOnAnUntradedSession(t *testing.T) {
	// Entry on session 2 with a 3-session time stop: due on session 5. Session 5
	// has no bar, so the exit is decided there and fills at session 6's open.
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitTimeStop, Sessions: 3}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	Step(st, sessionAt(5))
	if _, queued := st.exits["AAA"]; !queued {
		t.Fatal("the time stop was not decided on the session with no bar")
	}
	Step(st, sessionAt(6, codeAt("AAA", statusTriggered, mkBar(10.4, 10.4))))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonTimeStop || tr.ExitDate != dayAt(6) {
		t.Fatalf("exit %s on %v, want time_stop on session 6", tr.ExitReason, tr.ExitDate)
	}
}

func TestPivotExitCountsConsecutiveCloses(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot, Sessions: 2}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9.5))))
	if _, queued := st.exits["AAA"]; queued {
		t.Fatal("one close below the pivot queued an exit; two were needed")
	}
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(9.5, 9.4))))
	if _, queued := st.exits["AAA"]; !queued {
		t.Fatal("two consecutive closes below the pivot did not queue an exit")
	}
}

func TestPriceReturnFlagOnTheEntryAndExitBars(t *testing.T) {
	// A k artefact on the entry bar cannot change the trade: its fill and its
	// mark share the same multiplier, so it is not flagged.
	t.Run("entry bar is not flagged", func(t *testing.T) {
		spike := features.Bar{Open: 10, High: 10, Low: 10, Close: 10, AdjClose: 13, Volume: 1e6}
		st := enter(t, testConfig(), spike)
		pos := st.positions["AAA"]
		if pos == nil {
			t.Fatal("no position")
		}
		if pos.flags[FlagPriceReturnOnly] {
			t.Fatal("an artefact on the entry bar flagged the trade")
		}
	})
	// A k artefact on the bar whose open fills the exit does change the exit's
	// price basis, so it is flagged.
	t.Run("exit bar is flagged", func(t *testing.T) {
		cfg := testConfig()
		cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
		st := enter(t, cfg, mkBar(10, 10))
		Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9.5))))
		spike := features.Bar{Open: 9.4, High: 9.4, Low: 9.4, Close: 9.4, AdjClose: 13, Volume: 1e6}
		Step(st, sessionAt(4, codeAt("AAA", statusTriggered, spike)))
		tr := st.Finish()[0]
		if !hasFlag(tr.Flags, FlagPriceReturnOnly) {
			t.Fatalf("an artefact on the exit-fill bar was not flagged: %v", tr.Flags)
		}
	})
}

func TestGrossIncludesCashDividends(t *testing.T) {
	// One unadjusted 50c dividend on 1,000 units bought at 10 and held: the
	// price is flat, so the total return before costs is 500 on 10,000.
	st := enter(t, testConfig(), mkBar(10, 10))
	ex := codeAt("AAA", statusTriggered, mkBar(10, 10))
	ex.Dividend = 0.5
	Step(st, sessionAt(3, ex))
	tr := st.Finish()[0]
	near(t, "gross on a flat price with a dividend", tr.Gross, 0.05, 1e-9)
	if tr.Net > tr.Gross {
		t.Fatalf("net %v above gross %v", tr.Net, tr.Gross)
	}
	near(t, "dividends on the trade", tr.Dividends, 500, 1e-6)
}

func TestRecordCarriesDrawdown(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitStopLoss, Pct: 50}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 9))))
	r := recordAt(t, st, 3)
	peak := 0.0
	for _, rec := range st.Records() {
		if rec.Equity > peak {
			peak = rec.Equity
		}
	}
	near(t, "drawdown on session 3", r.Drawdown, r.Equity/peak-1, 1e-12)
	if r.Drawdown >= 0 {
		t.Fatalf("drawdown %v on a falling session", r.Drawdown)
	}
}

func TestNewStateRequiresThePriceQuantumDate(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("NewState accepted a zero Price4dpFrom")
		}
	}()
	cfg := testConfig()
	cfg.Price4dpFrom = civil.Date{}
	NewState(cfg)
}
