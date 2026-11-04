package engine

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// evaluateGoldenPath is the engine's output golden: the ranked picks and the
// rule outcomes of every registered strategy over a fixed set of candidates, in
// an uptrend and in a downtrend. It is the engine output that
// TestEngineVersionBumpedWithGoldens holds Version to.
const evaluateGoldenPath = "testdata/evaluate.golden"

// downtrend is a market regime that gates the strategies which need an uptrend.
var downtrend = Regime{IndexCode: "XJO", Label: RegimeDowntrend, Close: new(float64(8000)), SMA50: new(float64(8600)), SMA200: new(float64(8200)), AsOf: d("2026-09-25")}

// renderEvaluateOutput evaluates every registered strategy over fixed
// candidates and renders the result line by line. Values are printed to six
// significant figures so a change in a score or a value shows, and a change of
// rounding noise does not.
func renderEvaluateOutput() string {
	setup := zangerReady("SET")
	setup.BreakoutRecent = new(false)
	setup.Close = 9.2

	illiquid := zangerReady("ILQ")
	illiquid.DollarVolume20d = new(float64(50_000))

	cands := []Candidate{
		zangerReady("RDY"),
		setup,
		illiquid,
		qualityReady("QLY"),
		{StockCode: "NIL", Close: 1},
	}
	regimes := []struct {
		name   string
		regime Regime
	}{{"uptrend", uptrend}, {"downtrend", downtrend}}

	var b strings.Builder
	for _, s := range Registry() {
		for _, reg := range regimes {
			fmt.Fprintf(&b, "== %s %s\n", s.ID, reg.name)
			for _, p := range Evaluate(s, cands, reg.regime) {
				fmt.Fprintf(&b, "%d %s %v score=%.6g\n", p.Rank, p.Candidate.StockCode, p.Status, p.Score)
				for _, r := range p.Rules {
					if r.HasValue {
						fmt.Fprintf(&b, "  %s %v value=%.6g\n", r.RuleID, r.Status, r.Value)
					} else {
						fmt.Fprintf(&b, "  %s %v\n", r.RuleID, r.Status)
					}
				}
			}
		}
	}
	return b.String()
}

// TestEvaluateOutputIsPinned holds the engine's output to its golden. A change
// to any output is a change to what the engine means by its version: bump
// Version (TestEngineVersionBumpedWithGoldens) and regenerate the golden with
// UPDATE_ENGINE_GOLDENS=1 in the same commit.
func TestEvaluateOutputIsPinned(t *testing.T) {
	got := renderEvaluateOutput()
	if os.Getenv("UPDATE_ENGINE_GOLDENS") == "1" {
		if err := os.WriteFile(evaluateGoldenPath, []byte(got), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		return
	}
	want, err := os.ReadFile(evaluateGoldenPath)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if got == string(want) {
		return
	}
	gl, wl := strings.Split(got, "\n"), strings.Split(string(want), "\n")
	for i := 0; i < len(gl) || i < len(wl); i++ {
		var g, w string
		if i < len(gl) {
			g = gl[i]
		}
		if i < len(wl) {
			w = wl[i]
		}
		if g != w {
			t.Fatalf("engine output differs from %s at line %d:\n got: %q\nwant: %q", evaluateGoldenPath, i+1, g, w)
		}
	}
}
