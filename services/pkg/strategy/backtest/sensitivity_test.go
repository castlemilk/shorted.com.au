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

// TestFragileFlagIsASignFlipOfTheExcess: a timing or cost run carries its flag
// exactly when the base excess CAGR over the benchmark is positive and the
// variant's is at or below zero. The flag is absent from runs that do not flip.
func TestFragileFlagIsASignFlipOfTheExcess(t *testing.T) {
	sens := goldenSens(t)
	for _, run := range sens.Runs {
		if !run.Applies {
			continue
		}
		want := flagFor(run.ID, sens.Base, run.Figures)
		if run.Fragile != want {
			t.Fatalf("%s: flag %q, want %q", run.ID, run.Fragile, want)
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
