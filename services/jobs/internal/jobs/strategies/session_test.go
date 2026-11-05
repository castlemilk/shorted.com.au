package strategies

import (
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// weekdayBars returns priced weekday bars ending on d, n of them, with a close
// that rises by step each session from base.
func weekdayBars(d civil.Date, n int, base, step float64) []features.Bar {
	var days []civil.Date
	for cur := d; len(days) < n; cur = cur.AddDays(-1) {
		if w := tradingDayTime(cur).Weekday(); w != time.Saturday && w != time.Sunday {
			days = append(days, cur)
		}
	}
	out := make([]features.Bar, 0, n)
	for i := len(days) - 1; i >= 0; i-- {
		k := float64(len(days) - 1 - i)
		c := base + step*k
		out = append(out, features.Bar{
			Date: days[i], Open: c, High: c * 1.01, Low: c * 0.99, Close: c, AdjClose: c, Volume: 1_000_000,
		})
	}
	return out
}

// weekdayIndex returns index bars over the same days as weekdayBars.
func weekdayIndex(bars []features.Bar, base, step float64) []features.IndexBar {
	out := make([]features.IndexBar, 0, len(bars))
	for i, b := range bars {
		c := base + step*float64(i)
		out = append(out, features.IndexBar{Date: b.Date, High: c * 1.01, Low: c * 0.99, Close: c})
	}
	return out
}

// sessionFixture is a small universe: a long history, a short one and an ETF.
func sessionFixture(t *testing.T, d civil.Date) sessionInputs {
	t.Helper()
	long := weekdayBars(d, 320, 10, 0.05)
	xjo := weekdayIndex(long, 5000, 3)
	return sessionInputs{
		D:     d,
		Codes: []string{"AAA", "ETF", "NEW"},
		Bars: map[string][]features.Bar{
			"AAA": long,
			"ETF": weekdayBars(d, 320, 20, 0.02),
			"NEW": weekdayBars(d, 12, 3, 0.1),
		},
		XJO:       xjo,
		ETP:       map[string]bool{"ETF": true},
		Names:     map[string]string{"AAA": "ALPHA MINING LIMITED", "ETF": "BETA EXCHANGE TRADED FUND"},
		Dividends: map[string][]features.Dividend{"AAA": {{ExDate: d, AmountPerShare: 0.5}}},
	}
}

func TestBuildSessionRowsWritesEveryCodeWithItsReason(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, err := featureParams()
	if err != nil {
		t.Fatal(err)
	}
	out := buildSessionRows(sessionFixture(t, d), fs)

	if len(out.Rows) != 3 {
		t.Fatalf("rows = %d, want one per code", len(out.Rows))
	}
	byCode := map[string]snapshot.Row{}
	for _, r := range out.Rows {
		byCode[r.StockCode] = r
	}

	aaa := byCode["AAA"]
	if !aaa.OrdinaryFresh60 || aaa.IneligibleReason != "" {
		t.Errorf("AAA: ordinary_fresh_60=%v reason=%q, want fresh with no reason", aaa.OrdinaryFresh60, aaa.IneligibleReason)
	}
	if aaa.BarDate != d || aaa.Features.Bar.C == 0 {
		t.Errorf("AAA: bar_date=%s bar close=%v, want the session's bar", aaa.BarDate, aaa.Features.Bar.C)
	}
	if aaa.Features.ExDiv != 0.5 {
		t.Errorf("AAA: ex_div=%v, want the 0.5 dividend on the session", aaa.Features.ExDiv)
	}
	if !aaa.HasPrice() {
		t.Errorf("AAA: the price features must be present")
	}

	etf := byCode["ETF"]
	if etf.OrdinaryFresh60 || etf.IneligibleReason != "exchange_traded_product" {
		t.Errorf("ETF: reason=%q fresh=%v, want exchange_traded_product", etf.IneligibleReason, etf.OrdinaryFresh60)
	}

	nw := byCode["NEW"]
	if nw.OrdinaryFresh60 || nw.IneligibleReason != snapshot.ReasonShortHistory {
		t.Errorf("NEW: reason=%q, want short_history under 60 priced sessions", nw.IneligibleReason)
	}
	if nw.HasPrice() {
		t.Errorf("NEW: no price features should be stored under 60 sessions")
	}
}

func TestBuildSessionRowsBlobsKeyByProvenanceFreeHash(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	in := sessionFixture(t, d)
	in.Fund = map[string]features.Fundamentals{"AAA": {Hash: "abc", Blob: []byte(`{"growth":null}`)}}
	out := buildSessionRows(in, fs)
	if _, ok := out.Blobs["abc"]; !ok {
		t.Fatalf("a row with fundamentals must store its blob under the hash")
	}
	for _, r := range out.Rows {
		if r.StockCode == "AAA" && r.FundamentalsHash != "abc" {
			t.Errorf("AAA fundamentals_hash = %q, want abc", r.FundamentalsHash)
		}
	}
}

func TestEvaluateVersionRebuildsTheUniverseFromStoredRows(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	out := buildSessionRows(sessionFixture(t, d), fs)
	v, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		t.Fatal("no live zanger version")
	}
	ev, err := evaluateVersion(out.Rows, out.Blobs, out.Regime, v)
	if err != nil {
		t.Fatalf("evaluateVersion: %v", err)
	}
	// The v0 universe is every code with price features and 60 priced sessions:
	// AAA and the ETF qualify; the 12-session stock does not.
	if ev.Eligible != 2 {
		t.Errorf("eligible = %d, want 2 (AAA and the ETF)", ev.Eligible)
	}
	if ev.RulesHash == "" {
		t.Errorf("the evaluation must carry the version's rules hash")
	}
	for code := range ev.Picks {
		if code == "NEW" {
			t.Errorf("an ineligible code cannot be a pick")
		}
	}
}

func TestEvaluateVersionIsDeterministicForAStoredSession(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	out := buildSessionRows(sessionFixture(t, d), fs)
	v, _ := spec.Live(spec.StrategyZangerBreakout)
	a, err := evaluateVersion(out.Rows, out.Blobs, out.Regime, v)
	if err != nil {
		t.Fatal(err)
	}
	b, err := evaluateVersion(out.Rows, out.Blobs, out.Regime, v)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Picks) != len(b.Picks) {
		t.Fatalf("picks differ between two evaluations of one session")
	}
	for code, p := range a.Picks {
		q, ok := b.Picks[code]
		if !ok || q.Status != p.Status || q.Score != p.Score {
			t.Errorf("%s: %+v vs %+v", code, p, q)
		}
	}
	_ = engine.Version
}

func TestUniverseReasonOrder(t *testing.T) {
	etp := map[string]bool{"ETF": true}
	cases := []struct {
		name   string
		onD    bool
		price  bool
		priced int
		ord    bool
		ca     bool
		code   string
		want   string
	}{
		{name: "no bar", onD: false, price: true, priced: 300, ord: true, code: "AAA", want: snapshot.ReasonNoBarOnSession},
		{name: "short history", onD: true, price: true, priced: 10, ord: true, code: "AAA", want: snapshot.ReasonShortHistory},
		{name: "exchange traded", onD: true, price: true, priced: 300, ord: false, code: "ETF", want: "exchange_traded_product"},
		{name: "corporate action", onD: true, price: true, priced: 300, ord: true, ca: true, code: "AAA", want: "corporate_action_guard"},
		{name: "fresh", onD: true, price: true, priced: 300, ord: true, code: "AAA", want: ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := universeReason(c.onD, c.price, c.priced, c.ord, c.code, "", "", 0, etp, c.ca)
			if got != c.want {
				t.Fatalf("universeReason = %q, want %q", got, c.want)
			}
		})
	}
}
