package backtest

import (
	"math"
	"testing"
	"time"
)

// base is the first session of every fixture. Session i is base plus i days.
var base = time.Date(2025, 3, 3, 0, 0, 0, 0, time.UTC)

func dayAt(i int) time.Time { return base.AddDate(0, 0, i) }

// mkBar is a traded bar whose adjusted close equals its close (k = 1).
func mkBar(open, close float64) Bar {
	return Bar{
		Present: true,
		Open:    open,
		High:    math.Max(open, close),
		Low:     math.Min(open, close),
		Close:   close,
		Adj:     close,
		Volume:  1e6,
	}
}

// untradedBar is a row with zero volume: present, not traded.
func untradedBar(open, close float64) Bar {
	b := mkBar(open, close)
	b.Volume = 0
	return b
}

// codeAt is a code's session with the default signals: score 1, pivot 10,
// DV20 A$1bn (so capacity never binds and the spread is 5 bps).
func codeAt(code, status string, b Bar) CodeSession {
	return CodeSession{Code: code, Status: status, Bar: b, Score: 1, Pivot: 10, DV20: 1e9}
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
		Costs:            HouseCosts(),
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
func enter(t *testing.T, cfg Config, fill Bar) *State {
	t.Helper()
	st := NewState(cfg)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
	Step(st, sessionAt(2, codeAt("AAA", StatusTriggered, fill)))
	return st
}

func TestEntryFillsAtNextTradedOpen(t *testing.T) {
	st := enter(t, testConfig(), mkBar(10.5, 10.6))
	pos := st.positions["AAA"]
	if pos == nil {
		t.Fatal("no position after the fill session")
	}
	if !pos.entryDate.Equal(dayAt(2)) {
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
	thin := codeAt("AAA", StatusTriggered, mkBar(10, 10))
	thin.DV20 = 100000 // 5% of A$100k is A$5,000, below the A$10,000 weight
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, thin))
	Step(st, sessionAt(2, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
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
	fill := Bar{Present: true, Open: 0, High: 10.4, Low: 10.4, Close: 10.4, Adj: 10.4, Volume: 1e6}
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
	cfg.ExitRules = []ExitRule{{Kind: RuleCloseBelowCapturedPivot}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 9.5)))) // close below the pivot of 10
	if _, queued := st.exits["AAA"]; !queued {
		t.Fatal("a close below the pivot did not queue an exit")
	}
	Step(st, sessionAt(4, codeAt("AAA", StatusTriggered, untradedBar(9.8, 9.8))))
	if _, ok := st.positions["AAA"]; !ok {
		t.Fatal("an untraded bar closed the position")
	}
	Step(st, sessionAt(5, codeAt("AAA", StatusTriggered, mkBar(9.8, 9.9))))
	trades := st.Finish()
	if len(trades) != 1 {
		t.Fatalf("got %d trades, want 1", len(trades))
	}
	tr := trades[0]
	if tr.ExitReason != ReasonPivotStop || !tr.ExitDate.Equal(dayAt(5)) {
		t.Fatalf("exit %s on %v, want pivot_stop on session 5", tr.ExitReason, tr.ExitDate)
	}
	near(t, "exit price", tr.ExitPrice, 9.8, 1e-12)
	if !hasFlag(tr.Flags, FlagDelayedExit) {
		t.Fatalf("delayed_exit missing from flags %v", tr.Flags)
	}
}

func TestTimeStopFillsAfterTheNthSession(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []ExitRule{{Kind: RuleTimeStop, Sessions: 3}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 10.1))))
	Step(st, sessionAt(4, codeAt("AAA", StatusTriggered, mkBar(10, 10.2))))
	Step(st, sessionAt(5, codeAt("AAA", StatusTriggered, mkBar(10, 10.3)))) // 3 sessions after entry
	Step(st, sessionAt(6, codeAt("AAA", StatusTriggered, mkBar(10.4, 10.4))))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonTimeStop || !tr.ExitDate.Equal(dayAt(6)) {
		t.Fatalf("exit %s on %v, want time_stop on session 6", tr.ExitReason, tr.ExitDate)
	}
	if tr.SessionsHeld != 4 {
		t.Fatalf("sessions held %d, want 4", tr.SessionsHeld)
	}
}

func TestStopLossExit(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []ExitRule{{Kind: RuleStopLoss, Pct: 8}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 9.1)))) // 9.1 <= 10 x 0.92 = 9.2
	Step(st, sessionAt(4, codeAt("AAA", StatusTriggered, mkBar(9, 9.05))))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonStopLoss {
		t.Fatalf("exit reason %s, want stop_loss", tr.ExitReason)
	}
	near(t, "stop-loss fill", tr.ExitPrice, 9, 1e-12)
}

func TestSMAExitOnOneClose(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []ExitRule{{Kind: RuleCloseBelowSMA, SMA: 50}}
	st := enter(t, cfg, mkBar(10, 10))
	c3 := codeAt("AAA", StatusTriggered, mkBar(10, 10))
	c3.SMA50 = 9.5
	Step(st, sessionAt(3, c3))
	c4 := codeAt("AAA", StatusTriggered, mkBar(9.4, 9.4))
	c4.SMA50 = 9.5
	Step(st, sessionAt(4, c4)) // close 9.4 below SMA 9.5
	Step(st, sessionAt(5, codeAt("AAA", StatusTriggered, mkBar(9.3, 9.3))))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonSMAStop || !tr.ExitDate.Equal(dayAt(5)) {
		t.Fatalf("exit %s on %v, want sma_stop on session 5", tr.ExitReason, tr.ExitDate)
	}
}

func TestStatusExitNeedsConsecutiveSessions(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []ExitRule{{Kind: RuleStatusFallsTo, Statuses: []string{"watch", "none"}, Sessions: 2}}
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
		lastLoaded time.Time
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
			cfg.LastLoaded = map[string]time.Time{"AAA": tc.lastLoaded}
			st := enter(t, cfg, mkBar(10, 10))
			Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
			Step(st, sessionAt(4))
			Step(st, sessionAt(5))
			if _, ok := st.positions["AAA"]; !ok {
				t.Fatal("the position closed before the stale run ended")
			}
			Step(st, sessionAt(6))
			tr := st.Finish()[0]
			if tr.ExitReason != tc.want || !tr.ExitDate.Equal(dayAt(6)) {
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
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 11))))
	// Bar 4 is the suspect: a -55% gap. It is known on session 6.
	Step(st, sessionAt(4, codeAt("AAA", StatusTriggered, mkBar(11, 5))))
	Step(st, sessionAt(5, codeAt("AAA", StatusTriggered, mkBar(5, 5))))
	c6 := codeAt("AAA", StatusTriggered, mkBar(5, 5))
	c6.CA = CASuspect{Known: true, SuspectDate: dayAt(4), PrePL: 11}
	Step(st, sessionAt(6, c6))
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("the position survived the corporate-action exclusion")
	}
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonCorporateAction || !tr.ExitDate.Equal(dayAt(6)) {
		t.Fatalf("exit %s on %v, want corporate_action_exit on session 6", tr.ExitReason, tr.ExitDate)
	}
	near(t, "exclusion price", tr.ExitPrice, 11, 1e-12)
}

func TestCorporateActionLeavesAPositionEnteredOnTheSuspectBar(t *testing.T) {
	st := NewState(testConfig())
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(2, codeAt("AAA", StatusTriggered, mkBar(10, 10)))) // candidate; fills on 3
	c3 := codeAt("AAA", StatusTriggered, mkBar(10, 4))
	c3.CA = CASuspect{Known: true, SuspectDate: dayAt(3), PrePL: 10}
	Step(st, sessionAt(3, c3))
	if _, ok := st.positions["AAA"]; !ok {
		t.Fatal("a position entered on the suspect bar was closed by the exclusion")
	}
}

func TestCooldownBlocksReentry(t *testing.T) {
	cfg := testConfig()
	cfg.ExitRules = []ExitRule{{Kind: RuleCloseBelowCapturedPivot}}
	st := enter(t, cfg, mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 9.5))))
	Step(st, sessionAt(4, codeAt("AAA", "setup", mkBar(9.6, 9.6)))) // exit fills on 4
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("exit did not fill on session 4")
	}
	Step(st, sessionAt(5, codeAt("AAA", StatusTriggered, mkBar(9.6, 9.6))))
	if len(st.entries) != 0 {
		t.Fatal("a re-trigger one session after the exit was scheduled")
	}
	for i := 6; i <= 13; i++ {
		Step(st, sessionAt(i, codeAt("AAA", "setup", mkBar(9.6, 9.6))))
	}
	Step(st, sessionAt(14, codeAt("AAA", StatusTriggered, mkBar(9.6, 9.6)))) // 10 sessions after the exit
	if len(st.entries) != 1 || st.entries[0].code != "AAA" {
		t.Fatalf("re-entry after the cooldown not scheduled: %+v", st.entries)
	}
}

func TestCorporateActionBlocksNewEntriesForSixtySessions(t *testing.T) {
	st := NewState(testConfig())
	c1 := codeAt("AAA", "setup", mkBar(10, 10))
	c1.CA = CASuspect{Known: true, SuspectDate: dayAt(1), PrePL: 10}
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, c1))
	Step(st, sessionAt(2, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
	if len(st.entries) != 0 {
		t.Fatal("a candidate one session after a corporate-action suspect was scheduled")
	}
	for i := 3; i <= 63; i++ {
		Step(st, sessionAt(i, codeAt("AAA", "setup", mkBar(10, 10))))
	}
	Step(st, sessionAt(64, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
	if len(st.entries) != 1 {
		t.Fatal("entry 63 sessions after the suspect was still blocked")
	}
}

func TestFreshRuleSkipsATradedBreakout(t *testing.T) {
	cfg := testConfig()
	cfg.CooldownSessions = 0
	cfg.NewBreakoutOnly = true
	cfg.ExitRules = []ExitRule{{Kind: RuleStopLoss, Pct: 8}}
	st := NewState(cfg)
	brk := dayAt(1)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	trig := codeAt("AAA", StatusTriggered, mkBar(10, 10))
	trig.BreakoutDate = brk
	Step(st, sessionAt(1, trig))
	Step(st, sessionAt(2, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 9))))
	Step(st, sessionAt(4, codeAt("AAA", "setup", mkBar(9, 9))))
	if _, ok := st.positions["AAA"]; ok {
		t.Fatal("the stop did not close the position")
	}
	again := codeAt("AAA", StatusTriggered, mkBar(9, 9))
	again.BreakoutDate = brk
	Step(st, sessionAt(5, codeAt("AAA", "setup", mkBar(9, 9))))
	Step(st, sessionAt(6, again))
	if len(st.entries) != 0 {
		t.Fatal("a breakout already traded in this code was re-entered")
	}
	Step(st, sessionAt(7, codeAt("AAA", "setup", mkBar(9, 9))))
	fresh := codeAt("AAA", StatusTriggered, mkBar(9, 9))
	fresh.BreakoutDate = dayAt(8)
	Step(st, sessionAt(8, fresh))
	if len(st.entries) != 1 {
		t.Fatal("a new breakout date was not scheduled")
	}
}

func TestFirstSessionTriggeredDoesNotEnter(t *testing.T) {
	st := NewState(testConfig())
	Step(st, sessionAt(0, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
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
	ex := codeAt("AAA", StatusTriggered, mkBar(10, 9.5))
	ex.Dividend = 0.2
	Step(st, sessionAt(3, ex))
	pos := st.positions["AAA"]
	near(t, "dividend credited", pos.dividends, 0.2*pos.qty, 1e-9)
	near(t, "cash after the dividend", st.cash, 89985+0.2*pos.qty, 1e-9)
}

func TestDividendNotCreditedWhenVendorAdjusted(t *testing.T) {
	st := enter(t, testConfig(), mkBar(10, 10))
	ex := codeAt("AAA", StatusTriggered, Bar{Present: true, Open: 10, High: 10, Low: 9.5, Close: 9.5, Adj: 9.69, Volume: 1e6})
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
func payerScenario(t *testing.T, price4dpFrom time.Time) *State {
	t.Helper()
	cfg := testConfig()
	cfg.Price4dpFrom = price4dpFrom
	st := NewState(cfg)
	cents := func(open, close float64) Bar {
		return Bar{Present: true, Open: open, High: math.Max(open, close), Low: math.Min(open, close), Close: close, Adj: 1.47, Volume: 1e6}
	}
	Step(st, sessionAt(0, codeAt("AAA", "setup", cents(1.49, 1.49))))
	Step(st, sessionAt(1, codeAt("AAA", StatusTriggered, cents(1.49, 1.49))))
	Step(st, sessionAt(2, codeAt("AAA", StatusTriggered, cents(1.49, 1.49))))
	ex := codeAt("AAA", StatusTriggered, cents(1.5, 1.5))
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
	near(t, "multiplier", st.codeState("AAA").mult, 1.49/1.5, 1e-9)
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
	spike := Bar{Present: true, Open: 10, High: 10, Low: 10, Close: 10, Adj: 13, Volume: 1e6}
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, spike)))
	if got := st.codeState("AAA").mult; got != 1 {
		t.Fatalf("multiplier after a 30%% artefact = %v, want 1", got)
	}
	near(t, "equity on the artefact bar", recordAt(t, st, 3).Equity, before, 1e-9)
	Step(st, sessionAt(4, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
	if got := st.codeState("AAA").mult; got != 1 {
		t.Fatalf("the artefact reversal moved the multiplier to %v", got)
	}
	Step(st, sessionAt(5, codeAt("AAA", StatusTriggered, mkBar(10, 11))))
	near(t, "multiplier after a clean bar", st.codeState("AAA").mult, 1, 1e-12)
}

// fixedPath is one scripted round trip, with no dividends and no cash
// constraint, so every fill is the same whatever the costs.
func fixedPath(t *testing.T, multiplier float64) *State {
	t.Helper()
	cfg := testConfig()
	cfg.Costs.Multiplier = multiplier
	cfg.ExitRules = []ExitRule{{Kind: RuleCloseBelowCapturedPivot}}
	st := NewState(cfg)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", StatusTriggered, mkBar(10, 10.2))))
	Step(st, sessionAt(2, codeAt("AAA", StatusTriggered, mkBar(10.2, 10.6))))
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10.6, 11))))
	Step(st, sessionAt(4, codeAt("AAA", StatusTriggered, mkBar(11, 9.5))))
	Step(st, sessionAt(5, codeAt("AAA", StatusTriggered, mkBar(9.4, 9.4))))
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
	if !(two.Equity() <= one.Equity()) {
		t.Fatalf("final equity at 2x costs %v above 1x %v", two.Equity(), one.Equity())
	}
}

func TestOpenAtEndIsMarkedAndExcluded(t *testing.T) {
	st := enter(t, testConfig(), mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 12))))
	trades := st.Finish()
	if len(trades) != 1 || !trades[0].OpenAtEnd || trades[0].ExitReason != ReasonOpenAtEnd {
		t.Fatalf("open position not reported as open at end: %+v", trades)
	}
}

func TestUpJumpSuspectExitsOnItsOwnBar(t *testing.T) {
	// A 10x consolidation known on the bar it occurs: the position entered
	// before it closes at the pre-jump close, on that same session.
	st := enter(t, testConfig(), mkBar(10, 10))
	Step(st, sessionAt(3, codeAt("AAA", StatusTriggered, mkBar(10, 10))))
	jump := codeAt("AAA", StatusTriggered, mkBar(100, 100))
	jump.CA = CASuspect{Known: true, SuspectDate: dayAt(4), PrePL: 10}
	Step(st, sessionAt(4, jump))
	tr := st.Finish()[0]
	if tr.ExitReason != ReasonCorporateAction || !tr.ExitDate.Equal(dayAt(4)) {
		t.Fatalf("exit %s on %v, want corporate_action_exit on session 4", tr.ExitReason, tr.ExitDate)
	}
	near(t, "exit at the pre-jump close", tr.ExitPrice, 10, 1e-12)
}

func TestStepIsDeterministic(t *testing.T) {
	run := func() float64 {
		cfg := testConfig()
		cfg.ExitRules = []ExitRule{{Kind: RuleCloseBelowCapturedPivot}}
		st := NewState(cfg)
		a := codeAt("BBB", "setup", mkBar(5, 5))
		b := codeAt("AAA", "setup", mkBar(7, 7))
		Step(st, sessionAt(0, b, a))
		a.Status, b.Status = StatusTriggered, StatusTriggered
		a.Score, b.Score = 2, 2
		Step(st, sessionAt(1, b, a))
		Step(st, sessionAt(2, codeAt("AAA", StatusTriggered, mkBar(7, 7)), codeAt("BBB", StatusTriggered, mkBar(5, 5))))
		return st.Equity()
	}
	if x, y := run(), run(); x != y {
		t.Fatalf("two identical runs disagree: %v and %v", x, y)
	}
}
