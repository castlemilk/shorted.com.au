package strategies

import (
	"reflect"
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pipeline"
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
	v, ok := spec.Version(spec.StrategyZangerBreakout, "v0")
	if !ok {
		t.Fatal("no v0 zanger version")
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

// The live version's universe is the ordinary shares: v1 drops the exchange
// traded product that v0 evaluates, so the stored rows read under v1 are fewer.
func TestEvaluateVersionUnderV1DropsTheProduct(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	out := buildSessionRows(sessionFixture(t, d), fs)
	v1, ok := spec.Version(spec.StrategyZangerBreakout, "v1")
	if !ok {
		t.Fatal("no v1 zanger version")
	}
	ev, err := evaluateVersion(out.Rows, out.Blobs, out.Regime, v1)
	if err != nil {
		t.Fatalf("evaluateVersion: %v", err)
	}
	if ev.Eligible != 1 {
		t.Errorf("eligible under v1 = %d, want 1 (AAA; the ETF is not an ordinary share)", ev.Eligible)
	}
	if _, ok := ev.Picks["ETF"]; ok {
		t.Errorf("the exchange traded product cannot be a v1 pick")
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

// The window's rows answer a code only when they hold a qualifying row; a code
// whose newest one is older than the window is read from its whole history.
func TestShortReadingReadsTheWholeHistoryForACodeTheWindowMisses(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	in := sessionFixture(t, d)
	pct := 6.0
	in.ASICHistory = []features.ASICRow{{
		Code: "AAA", ReportDate: civil.Date{Year: 2024, Month: time.March, Day: 1},
		Product: "ALPHA MINING LIMITED", Positions: 1_000_000, Issued: 100_000_000, Percent: &pct,
	}}
	out := buildSessionRows(in, fs)
	for _, r := range out.Rows {
		if r.StockCode != "AAA" {
			continue
		}
		if r.Features.SF0.Status != features.StatusReported || r.Features.SF0.Pct == nil || *r.Features.SF0.Pct != 6 {
			t.Fatalf("AAA sf0 = %+v, want the 2024 report read from the whole history", r.Features.SF0)
		}
	}
}

// A session whose bar has no positive close is not priced on the session: the
// stored universe reads it as no bar, the pipeline's reason for the same code.
func TestUnpricedCloseOnTheSessionIsNoBarOnTheSession(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	in := sessionFixture(t, d)
	bars := in.Bars["AAA"]
	bars[len(bars)-1].Close = 0
	for _, r := range buildSessionRows(in, fs).Rows {
		if r.StockCode != "AAA" {
			continue
		}
		if r.OrdinaryFresh60 || r.IneligibleReason != snapshot.ReasonNoBarOnSession {
			t.Fatalf("AAA with a zero close on the session: fresh=%v reason=%q, want no_bar_on_session", r.OrdinaryFresh60, r.IneligibleReason)
		}
	}
}

// The fundamentals' fetch times leave the blob (and so its hash) and come back
// on the candidate through the row's meta.
func TestFundamentalsFetchTimesReturnThroughTheMeta(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	fetched := time.Date(2026, 11, 11, 3, 0, 0, 0, time.UTC)
	fund, err := pgsource.EncodeFundamentals(&engine.Growth{FetchedAt: &fetched}, nil)
	if err != nil {
		t.Fatal(err)
	}
	in := sessionFixture(t, d)
	in.Fund = map[string]features.Fundamentals{"AAA": fund}
	out := buildSessionRows(in, fs)
	var row snapshot.Row
	for _, r := range out.Rows {
		if r.StockCode == "AAA" {
			row = r
		}
	}
	if row.FundamentalsHash != fund.Hash {
		t.Fatalf("the row must point at the blob's hash")
	}
	v, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		t.Fatal("no live zanger version")
	}
	c, err := snapshot.ToCandidate(row, v.Spec, out.Blobs[row.FundamentalsHash])
	if err != nil {
		t.Fatal(err)
	}
	if c.Growth == nil || c.Growth.FetchedAt == nil || !c.Growth.FetchedAt.Equal(fetched) {
		t.Fatalf("the candidate's growth fetch time = %v, want %v", c.Growth, fetched)
	}
}

// The stored universe reasons are the pipeline's verdict for the base universe:
// the same code gets the same reason from both, whether its bar on the session
// has a close or not.
func TestStoredUniverseReasonsAgreeWithThePipeline(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	base, ok := spec.Live(spec.StrategyZangerBreakout)
	if !ok {
		t.Fatal("no live zanger version")
	}
	// The base universe the stored facts describe, as a version would name it.
	s := base.Spec
	s.Universe = spec.UniverseSpec{Instruments: "ordinary", Freshness: "bar_on_session", MinSessions: 60, LookbackDays: 400, CAGuard: true}
	s.Data.ShortSource = "latest_complete_published"
	s.Data.PublicationLagSessions = snapshotPublicationLag
	s.Data.MaxReportAgeSessions = 8
	s.Data.CAUpjumpFrom = caUpjumpFrom

	check := func(name string, in sessionInputs) {
		t.Helper()
		pin := &pipeline.Inputs{
			Codes: in.Codes, Bars: in.Bars, XJO: in.XJO, ASIC: in.ASIC, Ingests: in.Ingests,
			ETPSet: in.ETP, Names: in.Names,
		}
		_, _, inel := pipeline.BuildCandidates(d, pin, s)
		want := map[string]string{}
		for _, i := range inel {
			want[i.Code] = i.Reason
		}
		for _, r := range buildSessionRows(in, fs).Rows {
			if r.IneligibleReason != want[r.StockCode] {
				t.Errorf("%s: %s reason = %q, the pipeline says %q", name, r.StockCode, r.IneligibleReason, want[r.StockCode])
			}
		}
	}

	in := sessionFixture(t, d)
	check("priced session", in)

	in = sessionFixture(t, d)
	bars := in.Bars["AAA"]
	bars[len(bars)-1].Close = 0
	check("zero close on the session", in)
}

// The stored up-jump guard reads the date the v1 policy names, so the features
// the daily job writes and the policy the pipeline reads cannot drift apart.
func TestCAUpjumpFromIsTheV1Policy(t *testing.T) {
	v1, ok := spec.Version(spec.StrategyZangerBreakout, "v1")
	if !ok {
		t.Fatal("no v1 version for zanger-breakout")
	}
	if v1.Spec.Data.CAUpjumpFrom != caUpjumpFrom {
		t.Fatalf("v1 ca_upjump_from = %q, the daily job reads %q", v1.Spec.Data.CAUpjumpFrom, caUpjumpFrom)
	}
}

// The stored short reading and its staleness read the v1 policy's publication
// lag and maximum report age, so a change to either constant is a change to v1.
func TestStoredShortReadingIsTheV1Policy(t *testing.T) {
	v1, ok := spec.Version(spec.StrategyZangerBreakout, "v1")
	if !ok {
		t.Fatal("no v1 version for zanger-breakout")
	}
	if v1.Spec.Data.PublicationLagSessions != snapshotPublicationLag {
		t.Fatalf("v1 publication_lag_sessions = %d, the daily job stores %d", v1.Spec.Data.PublicationLagSessions, snapshotPublicationLag)
	}
	if v1.Spec.Data.MaxReportAgeSessions != features.StaleAfterSessions {
		t.Fatalf("v1 max_report_age_sessions = %d, the daily job stores %d", v1.Spec.Data.MaxReportAgeSessions, features.StaleAfterSessions)
	}
}

// v1 changes the universe, the short data and the ladder, never the thresholds:
// its rules, score, regime and features are v0's, as the changelog says.
func TestV1KeepsV0sThresholds(t *testing.T) {
	for _, id := range []string{spec.StrategyZangerBreakout, spec.StrategyCrowdedShortBreakout} {
		v0, ok0 := spec.Version(id, "v0")
		v1, ok1 := spec.Version(id, "v1")
		if !ok0 || !ok1 {
			t.Fatalf("%s: missing v0 or v1", id)
		}
		if !reflect.DeepEqual(v0.Spec.Rules, v1.Spec.Rules) || !reflect.DeepEqual(v0.Spec.Score, v1.Spec.Score) ||
			!reflect.DeepEqual(v0.Spec.Regime, v1.Spec.Regime) || !reflect.DeepEqual(v0.Spec.Features, v1.Spec.Features) {
			t.Fatalf("%s: v1 thresholds differ from v0's", id)
		}
	}
}

// flatThenBreakout is a stock that sat flat for its whole history, then closed
// above the pivot on heavy volume in its last sessions: its base and breakout
// pass, so with no fundamentals only the growth rule is unknown.
func flatThenBreakout(d civil.Date) []features.Bar {
	bars := weekdayBars(d, 320, 10, 0)
	n := len(bars)
	for i := n - 6; i < n; i++ {
		c := 10 + 0.2*float64(i-(n-6)+1)
		bars[i].Open, bars[i].Close, bars[i].AdjClose = c, c, c
		bars[i].High, bars[i].Low = c*1.01, c*0.99
		bars[i].Volume = 3_000_000
	}
	return bars
}

// The job applies each version's own ladder: with no fundamentals every growth
// rule is unknown, so v1 reads a pick whose other core rules pass as unknown,
// and v0 never does. Both read the same stored rows.
func TestEvaluateVersionAppliesItsOwnLadder(t *testing.T) {
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	fs, _ := featureParams()
	in := sessionFixture(t, d)
	in.Bars["AAA"] = flatThenBreakout(d)
	out := buildSessionRows(in, fs)
	v1, ok := spec.Version(spec.StrategyZangerBreakout, "v1")
	if !ok {
		t.Fatal("no v1 zanger version")
	}
	v0, ok := spec.Version(spec.StrategyZangerBreakout, "v0")
	if !ok {
		t.Fatal("no v0 zanger version")
	}
	noFundamentals := map[string]features.Fundamentals{}

	ev1, err := evaluateVersion(out.Rows, noFundamentals, out.Regime, v1)
	if err != nil {
		t.Fatalf("evaluateVersion v1: %v", err)
	}
	ev0, err := evaluateVersion(out.Rows, noFundamentals, out.Regime, v0)
	if err != nil {
		t.Fatalf("evaluateVersion v0: %v", err)
	}
	p1, ok := ev1.Picks["AAA"]
	if !ok {
		t.Fatalf("AAA is not a v1 pick: %v", ev1.Picks)
	}
	if p1.Status != string(engine.StatusUnknown) {
		t.Errorf("v1 AAA status = %q, want unknown (its growth rule is unknown and no core rule fails)", p1.Status)
	}
	if p0, ok := ev0.Picks["AAA"]; !ok || p0.Status == string(engine.StatusUnknown) {
		t.Errorf("v0 AAA = %+v, want its own ladder's setup or watch, never unknown", p0)
	}
}
