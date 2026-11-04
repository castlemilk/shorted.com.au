package backtest

import (
	"math"
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pipeline"
)

// orderedInputs returns the golden inputs with the codes and the ASIC rows in
// the reverse of their stored order: the same rows, delivered differently.
type orderedInputs struct {
	*MemoryInputs
	codes []string
	mkt   Market
}

func (o orderedInputs) Codes() []string { return o.codes }
func (o orderedInputs) Market() Market  { return o.mkt }

func reversedGolden(t *testing.T) orderedInputs {
	t.Helper()
	in := loadGolden(t)
	codes := in.Codes()
	for i, j := 0, len(codes)-1; i < j; i, j = i+1, j-1 {
		codes[i], codes[j] = codes[j], codes[i]
	}
	mkt := in.Mkt
	asic := append([]features.ASICRow(nil), mkt.ASIC...)
	for i, j := 0, len(asic)-1; i < j; i, j = i+1, j-1 {
		asic[i], asic[j] = asic[j], asic[i]
	}
	mkt.ASIC = asic
	return orderedInputs{MemoryInputs: in, codes: codes, mkt: mkt}
}

// runGolden runs the golden dataset under its version and recipe.
func runGolden(t *testing.T, in Inputs) Result {
	t.Helper()
	res, err := Run(in, goldenSpec(t), goldenRecipe(t))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// TestOrderIndependence: the codes and the ASIC rows in a different order give
// the same output hash.
func TestOrderIndependence(t *testing.T) {
	a := runGolden(t, loadGolden(t))
	b := runGolden(t, reversedGolden(t))
	if a.OutputHash != b.OutputHash {
		t.Fatalf("hash %s changed with the input order (%s)", b.OutputHash, a.OutputHash)
	}
}

// TestIdempotence: two runs in one process are equal, records and trades alike.
func TestIdempotence(t *testing.T) {
	in := loadGolden(t)
	a := runGolden(t, in)
	b := runGolden(t, in)
	if a.OutputHash != b.OutputHash || !reflect.DeepEqual(a.Records, b.Records) || !reflect.DeepEqual(a.Trades, b.Trades) {
		t.Fatal("two runs over the same inputs differ")
	}
}

// perturbAfter randomises every bar after cut, adjusted close included, every
// index bar after cut, and every ASIC row published after cut. It returns the
// perturbed copy; the input is left alone.
func perturbAfter(t *testing.T, in *MemoryInputs, cut civil.Date, rng *rand.Rand) *MemoryInputs {
	t.Helper()
	out := &MemoryInputs{BarsByCode: map[string][]features.Bar{}, Divs: in.Divs, Funds: in.Funds, Mkt: in.Mkt}
	for code, bars := range in.BarsByCode {
		nb := append([]features.Bar(nil), bars...)
		for i := range nb {
			if !nb[i].Date.After(cut) {
				continue
			}
			f := math.Exp(0.15 * rng.NormFloat64())
			g := math.Exp(0.15 * rng.NormFloat64())
			nb[i].Open *= f
			nb[i].High *= f
			nb[i].Low *= f
			nb[i].Close *= f
			nb[i].AdjClose *= f * g
			nb[i].Volume = math.Floor(nb[i].Volume * (0.5 + rng.Float64()))
		}
		out.BarsByCode[code] = nb
	}
	out.Mkt.XJO = perturbIndex(in.Mkt.XJO, cut, rng)
	out.Mkt.XJT = perturbIndex(in.Mkt.XJT, cut, rng)
	out.Mkt.ASIC = perturbASIC(in.Mkt, cut, goldenSpec(t).Data.PublicationLagSessions, rng)
	return out
}

func perturbIndex(bars []features.IndexBar, cut civil.Date, rng *rand.Rand) []features.IndexBar {
	out := append([]features.IndexBar(nil), bars...)
	for i := range out {
		if out[i].Date.After(cut) {
			f := math.Exp(0.05 * rng.NormFloat64())
			out[i].High *= f
			out[i].Low *= f
			out[i].Close *= f
		}
	}
	return out
}

// perturbASIC randomises the values of the rows published after cut. The
// publication date is the calendar's, the one the run reads.
func perturbASIC(m Market, cut civil.Date, lag int, rng *rand.Rand) []features.ASICRow {
	cal := calendarOf(m, lag)
	out := make([]features.ASICRow, len(m.ASIC))
	for i, r := range m.ASIC {
		out[i] = r
		if published, ok := cal.PublishedOn(r.ReportDate); !ok || published.After(cut) {
			f := 0.5 + rng.Float64()
			out[i].Positions *= f
			if out[i].Percent != nil {
				out[i].Percent = ptrF(*r.Percent * f)
			}
			out[i].Issued *= 0.5 + rng.Float64()
		}
	}
	return out
}

// calendarOf is the session calendar the run builds from the market rows.
func calendarOf(m Market, lag int) *calendar.Calendar {
	xjo := make([]civil.Date, len(m.XJO))
	for i, b := range m.XJO {
		xjo[i] = b.Date
	}
	seen := map[civil.Date]bool{}
	var asic []civil.Date
	for _, r := range m.ASIC {
		if !seen[r.ReportDate] {
			seen[r.ReportDate] = true
			asic = append(asic, r.ReportDate)
		}
	}
	sort.Slice(asic, func(i, j int) bool { return asic[i].Before(asic[j]) })
	return calendar.New(xjo, asic, lag)
}

// TestFuturePerturbation: for ten cut dates, randomising everything after the
// cut leaves the records, the events and the trades that close by the cut
// bit-identical.
func TestFuturePerturbation(t *testing.T) {
	in := loadGolden(t)
	base := runGolden(t, in)
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 10; i++ {
		k := 120 + rng.Intn(goldenSessions-240)
		cut := base.Sessions[k]
		got := runGolden(t, perturbAfter(t, in, cut, rng))
		if !reflect.DeepEqual(upTo(base.Records, cut), upTo(got.Records, cut)) {
			t.Fatalf("cut %s: equity before the cut changed", cut)
		}
		if !reflect.DeepEqual(eventsUpTo(base.Events, cut), eventsUpTo(got.Events, cut)) {
			t.Fatalf("cut %s: events before the cut changed", cut)
		}
		if !reflect.DeepEqual(closedBy(base.Trades, cut), closedBy(got.Trades, cut)) {
			t.Fatalf("cut %s: trades closed by the cut changed", cut)
		}
	}
}

// TestPublicationTiming: changing only one report's values leaves every
// decision before that report is public unchanged, and some decision on or
// after it changes. The loop over several reports must find one that crosses.
func TestPublicationTiming(t *testing.T) {
	in := loadGolden(t)
	base := runGolden(t, in)
	lag := goldenSpec(t).Data.PublicationLagSessions
	cal := calendarOf(in.Mkt, lag)
	crossed := false
	for _, r := range []int{20, 45, 70, 95, 120, 145, 170, 195, 220, 245} {
		report := base.Sessions[r]
		published, ok := cal.PublishedOn(report)
		if !ok {
			t.Fatalf("no publication date for %s", report)
		}
		alt := *in
		alt.Mkt.ASIC = append([]features.ASICRow(nil), in.Mkt.ASIC...)
		for i := range alt.Mkt.ASIC {
			if alt.Mkt.ASIC[i].ReportDate == report {
				alt.Mkt.ASIC[i].Positions *= 3
				alt.Mkt.ASIC[i].Percent = ptrF(*alt.Mkt.ASIC[i].Percent * 3)
			}
		}
		got := runGolden(t, &alt)
		if !reflect.DeepEqual(upTo(base.Records, published.AddDays(-1)), upTo(got.Records, published.AddDays(-1))) {
			t.Fatalf("report %s: a decision before it was public (%s) changed", report, published)
		}
		if !reflect.DeepEqual(base.Records, got.Records) {
			crossed = true
		}
	}
	if !crossed {
		t.Fatal("no report in the sample changed a later decision; the gate tests nothing")
	}
}

// TestStepEqualsRun is the pure form: the sessions Run builds, fed to Step one
// by one, reproduce Run's records and trades.
func TestStepEqualsRun(t *testing.T) {
	in := loadGolden(t)
	res := runGolden(t, in)
	p, err := prepare(in, goldenSpec(t), goldenRecipe(t))
	if err != nil {
		t.Fatal(err)
	}
	st := NewState(p.cfg)
	for _, s := range p.sessions {
		Step(st, s)
	}
	if !reflect.DeepEqual(st.Records(), res.Records) || !reflect.DeepEqual(st.Finish(), res.Trades) {
		t.Fatal("stepping the sessions by hand differs from Run")
	}
}

// TestBacktestSessionEqualsSnapshot is the golden form: on several sessions the
// candidates the backtest's pass 2 builds, and the picks they evaluate to, are
// the snapshot path's, field for field.
func TestBacktestSessionEqualsSnapshot(t *testing.T) {
	in := loadGolden(t)
	s := goldenSpec(t)
	strategy, ok := engine.Lookup(s.StrategyID)
	if !ok {
		t.Fatal("no strategy")
	}
	pin, err := pipelineInputs(in)
	if err != nil {
		t.Fatal(err)
	}
	idx := pipeline.NewIndex(pin, s)
	res := runGolden(t, in)
	for _, k := range []int{100, 250, 400, 600} {
		d := res.Sessions[k]
		cands, stats, _ := pipeline.BuildCandidates(d, pin, s)
		engine.PrepareCandidates(cands)
		env := engine.NewEnvFromStats(features.Regime(pin.XJO, d), stats)
		snapshot := map[string]engine.Pick{}
		for _, p := range engine.EvaluateWithEnv(strategy, cands, env) {
			snapshot[p.Candidate.StockCode] = p
		}
		for _, code := range pin.Codes {
			c, bad := idx.CandidateAt(code, d)
			if bad != nil {
				if _, ok := snapshot[code]; ok {
					t.Fatalf("%s on %s: pass 2 excludes it, the snapshot holds it", code, d)
				}
				continue
			}
			cands := []engine.Candidate{c}
			engine.PrepareCandidates(cands)
			pick, _ := engine.EvaluateOne(strategy, cands[0], env)
			want, ok := snapshot[code]
			if !ok {
				t.Fatalf("%s on %s: the snapshot does not hold it", code, d)
			}
			// Rank is the position in the snapshot's ranked list, not a property of the pick.
			want.Rank = 0
			if !reflect.DeepEqual(pick, want) {
				t.Fatalf("%s on %s: pick differs in %s", code, d, differingFields(pick, want))
			}
		}
	}
}

// TestCAGuardNeedsCorroboration: a fifty-per-cent gap with no share-count step
// and no zero-volume bar is not a corporate action, so no suspect voids it.
func TestCAGuardNeedsCorroboration(t *testing.T) {
	bars := make([]features.Bar, 40)
	for i := range bars {
		px := 10.0
		if i >= 20 {
			px = 5
		}
		d := civil.Date{Year: 2024, Month: 1, Day: 2}.AddDays(i)
		bars[i] = features.Bar{Date: d, Open: px, High: px, Low: px, Close: px, AdjClose: px, Volume: 1000}
	}
	cal := calendarOf(Market{XJO: xjoOf(bars)}, 0)
	if got := features.CASuspects(bars, nil, cal, civil.Date{Year: 2023, Month: 1, Day: 1}); len(got) != 0 {
		t.Fatalf("an uncorroborated -50%% gap is a suspect: %+v", got)
	}
}

// TestCAGuardIsPointInTime: a suspect corroborated only by a report published
// after T changes nothing up to T. The golden's consolidation of code GD09 is
// corroborated by the report of session 420, so the run with that report's
// share count altered is compared up to the session before it is public.
func TestCAGuardIsPointInTime(t *testing.T) {
	in := loadGolden(t)
	base := runGolden(t, in)
	lag := goldenSpec(t).Data.PublicationLagSessions
	report := base.Sessions[420]
	published, ok := calendarOf(in.Mkt, lag).PublishedOn(report)
	if !ok {
		t.Fatal("no publication date")
	}
	alt := *in
	alt.Mkt.ASIC = append([]features.ASICRow(nil), in.Mkt.ASIC...)
	for i := range alt.Mkt.ASIC {
		if alt.Mkt.ASIC[i].Code == "GD09" && alt.Mkt.ASIC[i].ReportDate == report {
			alt.Mkt.ASIC[i].Issued *= 2
		}
	}
	got := runGolden(t, &alt)
	cut := published.AddDays(-1)
	if !reflect.DeepEqual(upTo(base.Records, cut), upTo(got.Records, cut)) {
		t.Fatalf("a report public after %s changed equity before it", cut)
	}
}

// TestUpJumpConsolidationAfterResync: a tenfold up-jump after the last live
// re-sync, on a code outside the ASIC report, is no trigger, no trade and no
// phantom equity.
func TestUpJumpConsolidationAfterResync(t *testing.T) {
	in := loadGolden(t)
	s := goldenSpec(t)
	upjump, err := civil.ParseDate(s.Data.CAUpjumpFrom)
	if err != nil {
		t.Fatal(err)
	}
	cal := calendarOf(in.Mkt, s.Data.PublicationLagSessions)
	var rows []features.ASICRow
	for _, r := range in.Mkt.ASIC {
		if r.Code == "GD09" {
			rows = append(rows, r)
		}
	}
	suspects := features.CASuspects(in.BarsByCode["GD09"], rows, cal, upjump)
	foundUpjump := false
	for _, c := range suspects {
		if c.Kind == features.CAUpjump {
			foundUpjump = true
		}
	}
	if !foundUpjump {
		t.Fatal("the consolidation is not an up-jump suspect after the re-sync")
	}

	alt := *in
	alt.Mkt.ASIC = nil
	for _, r := range in.Mkt.ASIC {
		if r.Code != "GD09" {
			alt.Mkt.ASIC = append(alt.Mkt.ASIC, r)
		}
	}
	res := runGolden(t, &alt)
	for _, tr := range res.Trades {
		if tr.Code == "GD09" {
			t.Fatalf("GD09 traded outside the ASIC report: %+v", tr)
		}
	}
	for i := 1; i < len(res.Records); i++ {
		if r := res.Records[i].Equity / res.Records[i-1].Equity; r > 1.5 || r < 0.5 {
			t.Fatalf("equity moved %.2fx on %s: a phantom mark", r, res.Records[i].Date)
		}
	}
}

// xjoOf returns the index dates of a bar series, as a market's index.
func xjoOf(bars []features.Bar) []features.IndexBar {
	out := make([]features.IndexBar, len(bars))
	for i, b := range bars {
		out[i] = features.IndexBar{Date: b.Date, High: b.High, Low: b.Low, Close: b.Close}
	}
	return out
}

// upTo keeps the records dated on or before cut.
func upTo(recs []Record, cut civil.Date) []Record {
	var out []Record
	for _, r := range recs {
		if !r.Date.After(cut) {
			out = append(out, r)
		}
	}
	return out
}

// eventsUpTo keeps the events dated on or before cut.
func eventsUpTo(evs []Event, cut civil.Date) []Event {
	var out []Event
	for _, e := range evs {
		if !e.Date.After(cut) {
			out = append(out, e)
		}
	}
	return out
}

// closedBy keeps the trades that closed on or before cut.
func closedBy(trades []Trade, cut civil.Date) []Trade {
	var out []Trade
	for _, tr := range trades {
		if !tr.ExitDate.After(cut) && !tr.OpenAtEnd {
			out = append(out, tr)
		}
	}
	return out
}

// differingFields names the top-level fields of two picks that differ, and of
// their candidates, so a failing gate says where the paths part.
func differingFields(a, b engine.Pick) string {
	var out []string
	va, vb := reflect.ValueOf(a.Candidate), reflect.ValueOf(b.Candidate)
	for i := 0; i < va.NumField(); i++ {
		if !reflect.DeepEqual(va.Field(i).Interface(), vb.Field(i).Interface()) {
			out = append(out, "candidate."+va.Type().Field(i).Name)
		}
	}
	if !reflect.DeepEqual(a.Rules, b.Rules) {
		out = append(out, "rules")
	}
	if a.Score != b.Score || a.Status != b.Status {
		out = append(out, "score/status")
	}
	if !reflect.DeepEqual(a.RS6mPercentile, b.RS6mPercentile) {
		out = append(out, "rs6m percentile")
	}
	return strings.Join(out, ", ")
}
