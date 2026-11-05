package backtest

import (
	"testing"
)

// TestEntryLagFillsTwoSessionsAfterTheSignal: with the entry_plus_1 sensitivity a
// candidate triggered on session 1 is queued at its close, waits one session, and
// fills at session 3's open. The canonical run fills it at session 2's open.
func TestEntryLagFillsTwoSessionsAfterTheSignal(t *testing.T) {
	for _, tc := range []struct {
		lag  int
		fill int
	}{{0, 2}, {1, 3}} {
		cfg := testConfig()
		cfg.EntryLagSessions = tc.lag
		st := NewState(cfg)
		Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
		Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10))))
		Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10))))
		if tc.lag == 0 {
			if pos := st.positions["AAA"]; pos == nil || pos.entryDate != dayAt(tc.fill) {
				t.Fatalf("lag %d: position %+v, want an entry on session %d", tc.lag, pos, tc.fill)
			}
			continue
		}
		if st.positions["AAA"] != nil {
			t.Fatalf("lag %d: filled on session 2, before the lag", tc.lag)
		}
		Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 10))))
		if pos := st.positions["AAA"]; pos == nil || pos.entryDate != dayAt(tc.fill) {
			t.Fatalf("lag %d: position %+v, want an entry on session %d", tc.lag, pos, tc.fill)
		}
	}
}

// TestDelistedExitFillsAtZeroOnlyWhenSensitivity: a position that stops trading
// exits at its last close as delisted in the canonical run, and at zero when the
// delisting sensitivity is on. The suspended label is never zeroed.
func TestDelistedExitFillsAtZeroOnlyWhenSensitivity(t *testing.T) {
	for _, zero := range []bool{false, true} {
		cfg := testConfig()
		cfg.DelistingAtZero = zero
		st := NewState(cfg)
		Step(st, sessionAt(0, codeAt("AAA", "setup", mkBar(10, 10))))
		Step(st, sessionAt(1, codeAt("AAA", statusTriggered, mkBar(10, 10))))
		Step(st, sessionAt(2, codeAt("AAA", statusTriggered, mkBar(10, 10))))
		// The code has no bar from session 3 on, until the stale-exit run ends.
		for i := 3; i < 3+defaultStaleSessions+1; i++ {
			Step(st, sessionAt(i, CodeSession{Code: "AAA", Status: "none"}))
		}
		trades := st.Finish()
		if len(trades) != 1 {
			t.Fatalf("zero=%v: %d trades, want 1", zero, len(trades))
		}
		tr := trades[0]
		if tr.ExitReason != ReasonDelisted {
			t.Fatalf("zero=%v: exit reason %s, want %s", zero, tr.ExitReason, ReasonDelisted)
		}
		if zero && (tr.ExitPrice != 0 || tr.Net >= 0) {
			t.Fatalf("zero=true: exit price %v net %v, want a zero exit and a loss", tr.ExitPrice, tr.Net)
		}
		if !zero && tr.ExitPrice != 10 {
			t.Fatalf("zero=false: exit price %v, want the last close 10", tr.ExitPrice)
		}
	}
}

// goldenSens is the golden run's sensitivities, computed once for the tests that
// read them.
func goldenSens(t *testing.T) Sensitivities {
	t.Helper()
	in := loadGolden(t)
	sens, err := RunSensitivities(in, goldenSpec(t), goldenRecipe(t))
	if err != nil {
		t.Fatal(err)
	}
	return sens
}

// TestSensitivitiesTableAndApplicability: the five runs come in the table's order,
// the publication lag applies to Crowded-Short only, and every applicable run has
// figures.
func TestSensitivitiesTableAndApplicability(t *testing.T) {
	sens := goldenSens(t)
	want := []string{SensCostsX2, SensASICLagPlus2, SensDelistingZero, SensEntryPlus1, SensFlatMockup}
	if len(sens.Runs) != len(want) {
		t.Fatalf("%d runs, want %d", len(sens.Runs), len(want))
	}
	for i, id := range want {
		if sens.Runs[i].ID != id {
			t.Fatalf("run %d is %s, want %s", i, sens.Runs[i].ID, id)
		}
		if sens.Runs[i].Label == "" {
			t.Fatalf("run %s has no label", id)
		}
	}
	for _, run := range sens.Runs {
		if run.Applies && run.Figures.ClosedTrades == 0 && run.ID != SensASICLagPlus2 {
			t.Fatalf("applicable run %s reports no closed trades", run.ID)
		}
	}
	if !sens.Runs[1].Applies {
		t.Fatalf("the publication lag must apply to the Crowded-Short golden recipe")
	}
}

// TestFragileFlagIsASignFlipOfTheExcess pins the golden's flags against figures
// written down here, not against flagFor. The golden base excess is negative, so
// no sensitivity can flip it and every run is unflagged. The positive-base cases
// are TestFlagForTruthTable's.
func TestFragileFlagIsASignFlipOfTheExcess(t *testing.T) {
	sens := goldenSens(t)
	if !sens.Base.HasExcess || sens.Base.Excess >= 0 {
		t.Fatalf("base excess %v (has %v), want a negative golden excess", sens.Base.Excess, sens.Base.HasExcess)
	}
	for _, run := range sens.Runs {
		if run.Applies && run.Fragile != "" {
			t.Fatalf("%s: flagged %q, but the golden base cannot flip", run.ID, run.Fragile)
		}
	}
	// The entry-timing run stays a near miss of the base, not a flip: its excess
	// is within two points of the canonical run's, so a phantom mark cannot hide one.
	for _, run := range sens.Runs {
		if run.ID != SensEntryPlus1 {
			continue
		}
		if d := run.Figures.Excess - sens.Base.Excess; d > 0.02 || d < -0.02 {
			t.Fatalf("entry_plus_1 excess %v is %v from the base %v, want within two points",
				run.Figures.Excess, d, sens.Base.Excess)
		}
	}
}

// TestFlagForTruthTable pins the rule: a sign flip of an annualised excess sets
// the flag of the three timing and cost runs, and nothing else sets one.
func TestFlagForTruthTable(t *testing.T) {
	pos := Figures{Excess: 0.05, HasExcess: true}
	neg := Figures{Excess: -0.01, HasExcess: true}
	zero := Figures{Excess: 0, HasExcess: true}
	none := Figures{}
	cases := []struct {
		id      string
		base    Figures
		variant Figures
		want    string
	}{
		{SensCostsX2, pos, neg, FragileCosts},
		{SensASICLagPlus2, pos, zero, FragilePublicationTime},
		{SensEntryPlus1, pos, neg, FragileEntryTiming},
		{SensCostsX2, neg, neg, ""},
		{SensCostsX2, pos, pos, ""},
		{SensCostsX2, pos, none, ""},
		{SensCostsX2, none, neg, ""},
		{SensDelistingZero, pos, neg, ""},
		{SensFlatMockup, pos, neg, ""},
	}
	for _, c := range cases {
		if got := flagFor(c.id, c.base, c.variant); got != c.want {
			t.Fatalf("flagFor(%s, %+v, %+v) = %q, want %q", c.id, c.base, c.variant, got, c.want)
		}
	}
	if FragileChip(FragileCosts) != "Fragile to costs" || FragileChip(FragilePublicationTime) != "Fragile to publication timing" ||
		FragileChip(FragileEntryTiming) != "Fragile to entry timing" {
		t.Fatalf("the fragility chips do not carry the flags' copy")
	}
}

// TestEntryPlus1NeverBooksTheConsolidationBar: the golden code 1 signals on the
// session before its consolidation. Delayed one session its entry lands on the
// suspect bar, whose open is on the pre-event basis and whose close is not. The
// entry must be excluded at its entry price, not marked up tenfold, and the
// variant's figures stay within a band of the canonical run's.
func TestEntryPlus1NeverBooksTheConsolidationBar(t *testing.T) {
	in := loadGolden(t)
	p, err := prepare(in, goldenSpec(t), goldenRecipe(t), false)
	if err != nil {
		t.Fatal(err)
	}
	base, err := simulate(p)
	if err != nil {
		t.Fatal(err)
	}
	q := p
	q.cfg.EntryLagSessions = entryLagSessionsVariant
	lagged, err := simulate(q)
	if err != nil {
		t.Fatal(err)
	}
	suspect := goldenSessionDates()[goldenConsolidation]
	found := false
	for _, tr := range lagged.Trades {
		if tr.Code != goldenCode(1) || tr.EntryDate != suspect {
			continue
		}
		found = true
		if tr.ExitReason != ReasonCorporateAction {
			t.Fatalf("lagged entry on the suspect bar exited %s, want %s", tr.ExitReason, ReasonCorporateAction)
		}
		if tr.ExitPrice != tr.EntryFill {
			t.Fatalf("exit price %v, want the entry price %v (no move)", tr.ExitPrice, tr.EntryFill)
		}
		if tr.Net > 0.05 || tr.Net < -0.05 {
			t.Fatalf("net %v on a position that never moved, want a fee-sized figure", tr.Net)
		}
	}
	if !found {
		t.Fatalf("no lagged entry on the suspect bar %v; the golden no longer exercises it", suspect)
	}
	bf, lf := figuresOf(base), figuresOf(lagged)
	if !bf.HasTotalReturn || !lf.HasTotalReturn {
		t.Fatal("the canonical and lagged runs need a total return")
	}
	if d := lf.TotalReturn - bf.TotalReturn; d > 0.25 || d < -0.25 {
		t.Fatalf("lagged total return %v is %v from the canonical %v, want within 0.25", lf.TotalReturn, d, bf.TotalReturn)
	}
}
