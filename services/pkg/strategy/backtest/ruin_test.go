package backtest

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// ruinConfig is a small account whose brokerage minimum is more than its
// position: an exit can cost more than it sells for, which overdraws the cash.
func ruinConfig() Config {
	cfg := testConfig()
	cfg.Capital = 1000
	cfg.WeightPct = 100
	cfg.Costs.BrokerageMinAUD = 300
	cfg.ExitRules = []spec.ExitRule{{Kind: spec.ExitClosePivot}}
	return cfg
}

// An exit whose fee exceeds its proceeds ruins the run. The session that
// records the zero equity is the last with a negative figure in the cash: every
// later session records zero, trades nothing, and holds nothing.
func TestRuinFloorsEquityAtZeroAndStopsTheRun(t *testing.T) {
	cfg := ruinConfig()
	st := enter(t, cfg, mkBar(10, 10))
	if _, ok := st.positions["AAA"]; !ok {
		t.Fatal("setup: the entry did not fill")
	}
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 0.5))))
	Step(st, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(0.5, 0.5))))
	if !st.ruined {
		t.Fatal("the exit's fee exceeded its proceeds, yet the run was not ruined")
	}
	rec := recordAt(t, st, 4)
	if rec.Equity != 0 || rec.Cash != 0 || rec.Invested != 0 || rec.Exposure != 0 || rec.Drawdown != -1 {
		t.Fatalf("the ruined session recorded %+v", rec)
	}
	for i := 5; i <= 12; i++ {
		s := sessionAt(i, codeAt("BBB", "setup", mkBar(10, 10)))
		if i%2 == 0 {
			s.Codes[0].Status = statusTriggered
		}
		s.CashRate = 0.05 // no interest accrues on a wiped-out account
		s.Codes[0].Dividend = 0.5
		Step(st, s)
	}
	for _, r := range st.Records() {
		if r.Equity < 0 {
			t.Fatalf("session %v recorded negative equity %v", r.Date, r.Equity)
		}
	}
	for i := 5; i <= 12; i++ {
		r := recordAt(t, st, i)
		if r.Equity != 0 || r.Cash != 0 || r.Invested != 0 || r.Exposure != 0 || r.Drawdown != -1 {
			t.Fatalf("session %d after the ruin recorded %+v", i, r)
		}
	}
	if n := len(st.Closed()); n != 1 {
		t.Fatalf("%d closed trades; the ruin added none, so want the single exit", n)
	}
	if len(st.Holdings()) != 0 || len(st.PendingEntries()) != 0 {
		t.Fatal("a ruined run still holds a position or queues an entry")
	}
	ruinDate := rec.Date
	for _, e := range st.Events() {
		if e.Date.After(ruinDate) {
			t.Fatalf("event %+v after the ruin", e)
		}
	}
	if fees := st.Closed()[0].Fees; fees < 300 {
		t.Fatalf("the exit paid %v, below the 300 brokerage minimum that ruined the run", fees)
	}
}

// A ruin with a position still open sells it at its last mark, as a wiped_out
// trade that pays no exit cost. The cash is overdrawn here by hand, as an earlier
// exit's fee would have done.
func TestRuinWipesOpenPositionsAtTheirLastMark(t *testing.T) {
	cfg := ruinConfig()
	st := enter(t, cfg, mkBar(10, 10))
	open, ok := st.positions["AAA"]
	if !ok {
		t.Fatal("setup: the entry did not fill")
	}
	entryFee := open.entryFee
	st.cash = -10000
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 10))))

	if !st.ruined || len(st.Holdings()) != 0 {
		t.Fatalf("ruined %v, holdings %d after the ruin", st.ruined, len(st.Holdings()))
	}
	closed := st.Closed()
	if len(closed) != 1 {
		t.Fatalf("%d trades, want the one wiped_out trade", len(closed))
	}
	tr := closed[0]
	if tr.ExitReason != ReasonWipedOut || tr.OpenAtEnd {
		t.Fatalf("trade reason %q open %v, want wiped_out and closed", tr.ExitReason, tr.OpenAtEnd)
	}
	if math.Abs(tr.ExitPrice-10) > 1e-9 {
		t.Fatalf("sold at %v, want the last mark 10", tr.ExitPrice)
	}
	if math.Abs(tr.Fees-entryFee) > 1e-9 {
		t.Fatalf("fees %v, want the entry fee %v only (a wipe-out pays no exit cost)", tr.Fees, entryFee)
	}
	if !hasEvent(st, EventExitFilled, ReasonWipedOut) {
		t.Fatal("no exit_filled event with reason wiped_out")
	}
	rec := recordAt(t, st, 3)
	if rec.Equity != 0 || rec.Drawdown != -1 {
		t.Fatalf("the ruined session recorded %+v", rec)
	}
	for _, tr := range st.Finish() {
		if tr.OpenAtEnd {
			t.Fatal("Finish reports an open trade after a wipe-out")
		}
	}
}

// A ruined state survives a checkpoint: the restored run stays ruined. A version 1
// checkpoint, written before ruin existed, restores as not ruined; a version the
// build does not know is refused.
func TestRuinSurvivesACheckpoint(t *testing.T) {
	cfg := ruinConfig()
	st := enter(t, cfg, mkBar(10, 10))
	st.cash = -10000
	Step(st, sessionAt(3, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	raw, err := st.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreState(cfg, raw)
	if err != nil {
		t.Fatal(err)
	}
	if !restored.ruined {
		t.Fatal("the restored state is not ruined")
	}
	Step(restored, sessionAt(4, codeAt("AAA", statusTriggered, mkBar(10, 10))))
	if r := restored.Records()[len(restored.Records())-1]; r.Equity != 0 || r.Drawdown != -1 {
		t.Fatalf("the restored run recorded %+v after the ruin", r)
	}
	if len(restored.Closed()) != 0 || len(restored.Holdings()) != 0 {
		t.Fatal("the restored run traded after the ruin")
	}

	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	m["version"] = checkpointVersionV1
	delete(m, "ruined")
	v1, _ := json.Marshal(m)
	old, err := RestoreState(cfg, v1)
	if err != nil {
		t.Fatalf("a version 1 checkpoint is refused: %v", err)
	}
	if old.ruined {
		t.Fatal("a version 1 checkpoint restored as ruined")
	}
	m["version"] = checkpointVersion + 1
	future, _ := json.Marshal(m)
	if _, err := RestoreState(cfg, future); err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("an unknown checkpoint version was read: %v", err)
	}
}

// The metrics of a wiped-out curve: the total return and CAGR are -1, the
// drawdown is -1, and no daily figure is NaN or infinite.
func TestWipedOutCurveMetrics(t *testing.T) {
	first := civil.Date{Year: 2024, Month: 1, Day: 2}
	c := Curve{
		Dates:  []civil.Date{first, first.AddDays(100), first.AddDays(200), first.AddDays(300), first.AddDays(400)},
		Values: []float64{1000, 500, 0, 0, 0},
	}
	if tr, ok := TotalReturn(c); !ok || tr != -1 {
		t.Fatalf("total return %v, %v; want -1", tr, ok)
	}
	if cagr, ok := CAGR(c); !ok || cagr != -1 {
		t.Fatalf("CAGR %v, %v; want -1", cagr, ok)
	}
	short := Curve{Dates: c.Dates[:2], Values: []float64{1000, 0}}
	if _, ok := CAGR(short); ok {
		t.Fatal("a wipe-out inside 365 days is annualised")
	}
	if tr, ok := TotalReturn(short); !ok || tr != -1 {
		t.Fatalf("a short wipe-out's total return %v, %v; want -1", tr, ok)
	}
	if got := dailyReturns(c.Values); len(got) != 2 || got[0] != -0.5 || got[1] != -1 {
		t.Fatalf("daily returns %v; want [-0.5 -1] (pairs from zero have no return)", got)
	}
	dd := MaxDrawdown(c)
	if dd.Depth != -1 || dd.Trough != 2 {
		t.Fatalf("drawdown %+v; want depth -1 at trough 2", dd)
	}
	if vol, ok := Volatility(c); !ok || math.IsNaN(vol) || math.IsInf(vol, 0) {
		t.Fatalf("volatility %v, %v", vol, ok)
	}
	sr := Sharpe(c, nil)
	if sr.N != 2 || math.IsNaN(sr.Daily) || math.IsInf(sr.Daily, 0) || math.IsNaN(sr.Annual) || math.IsNaN(sr.SE) {
		t.Fatalf("Sharpe on a wipe-out: %+v", sr)
	}
}

// The risk-free rate is read at the prior session of each return, and a pair
// from a zero value is left out of both.
func TestSharpeAlignsRiskFreeToTheKeptReturns(t *testing.T) {
	first := civil.Date{Year: 2024, Month: 1, Day: 2}
	vals := []float64{100, 50, 0, 0, 0}
	c := Curve{Dates: []civil.Date{first, first.AddDays(1), first.AddDays(2), first.AddDays(3), first.AddDays(4)}, Values: vals}
	rf := []float64{0.01, 0.02, 0.03, 0.04}
	got := Sharpe(c, rf)
	if got.RiskFreeNone {
		t.Fatal("a risk-free series of one rate per session pair was read as absent")
	}
	ex := []float64{-0.5 - 0.01, -1 - 0.02}
	want := mean(ex) / sampleStdev(ex)
	if math.Abs(got.Daily-want) > 1e-12 {
		t.Fatalf("daily Sharpe %v, want %v (rates read at the prior session)", got.Daily, want)
	}
}

// Chaining a wiped-out in-sample run onto a paper track stays at zero.
func TestChainingAWipedOutRunStaysAtZero(t *testing.T) {
	live := civil.Date{Year: 2026, Month: 6, Day: 1}
	bt := Series{Basis: BasisTotal, Curve: dailyCurve(live.AddDays(-30), 30, func(k int) float64 {
		if k < 20 {
			return 100
		}
		return 0
	})}
	paper := Series{Basis: BasisTotal, Curve: dailyCurve(live, 10, func(k int) float64 { return 5000 + float64(k) })}
	got, err := Chain(bt, paper, live)
	if err != nil {
		t.Fatalf("chaining a wiped-out run: %v", err)
	}
	for _, v := range got.Curve.Values[len(got.Curve.Values)-10:] {
		if v != 0 {
			t.Fatalf("a chained track after a wipe-out is worth %v", v)
		}
	}
}
