package backtest

import "testing"

// TestAnEntryFillsFromTheCashAtItsOpen: a dividend registered on a held code's
// ex-date is paid into cash at the close, so a cash-bound entry on that same
// open is sized from the cash held before the dividend, and the dividend is
// still counted in the holder's trade.
func TestAnEntryFillsFromTheCashAtItsOpen(t *testing.T) {
	cfg := testConfig()
	cfg.WeightPct = 60
	cfg.MaxPositions = 2
	st := NewState(cfg)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10)), codeAt("BBB", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10)), codeAt("BBB", "setup", mkBar(10, 10))))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10)), codeAt("BBB", statusTriggered, mkBar(10, 10))))
	cashBeforeDividend := st.cash
	ex := codeAt("AAA", statusTriggered, mkBar(10, 10))
	ex.Dividend = 1
	Step(st, sessionAt(3, ex, codeAt("BBB", statusTriggered, mkBar(10, 10))))
	bbb, ok := st.positions["BBB"]
	if !ok {
		t.Fatal("BBB not filled")
	}
	notional := bbb.qty * bbb.entryPL
	if notional > cashBeforeDividend+1e-9 {
		t.Fatalf("BBB bought A$%.2f, more than the A$%.2f held at its open", notional, cashBeforeDividend)
	}
	aaa := st.positions["AAA"]
	if aaa == nil || aaa.dividends <= 0 {
		t.Fatal("AAA's ex-date dividend was not registered on the holder")
	}
	// The dividend reaches cash at the close: cash after the session is the cash
	// before it, less BBB's notional and fee, plus AAA's dividend.
	want := cashBeforeDividend - notional - bbb.entryFee + aaa.dividends
	near(t, "cash at the close", recordAt(t, st, 3).Cash, want, 1e-6)
}

// TestDividendsEarnNoInterestOnTheirExDate: the dividend is paid after the
// session's interest, so it does not accrue the day's cash rate.
func TestDividendsEarnNoInterestOnTheirExDate(t *testing.T) {
	cfg := testConfig()
	st := NewState(cfg)
	Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
	Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	held := st.positions["AAA"]
	if held == nil {
		t.Fatal("AAA not held")
	}
	ex := codeAt("AAA", statusTriggered, mkBar(10, 10))
	ex.Dividend = 0.5
	// A cash rate that would earn visible interest on the day's cash.
	cashRate := 0.2
	before := st.cash
	Step(st, Session{Date: dayAt(3), Index: 3, CashRate: cashRate, Codes: []CodeSession{ex}})
	credit := 0.5 * held.qty
	want := (before + 0) * (1 + DailyRate(cashRate)) // interest on the cash held at the close, before the dividend
	near(t, "cash after the ex-date", st.cash, want+credit, 1e-6)
}
