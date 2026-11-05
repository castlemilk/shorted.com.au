package backtest

import (
	"math"
	"math/rand"
	"reflect"
	"sort"
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

// planGolden prepares the golden dataset with every code's rows kept, so that
// the decisions of every code on every session can be compared.
func planGolden(t *testing.T, in Inputs) plan {
	t.Helper()
	p, err := prepare(in, goldenSpec(t), goldenRecipe(t), true)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// TestKeepAllIsRun: keeping every code's rows changes nothing the run reports.
// The decision gates simulate the keep-all plan, so this is what they stand on.
func TestKeepAllIsRun(t *testing.T) {
	in := loadGolden(t)
	res := runGolden(t, in)
	all, err := simulate(planGolden(t, in))
	if err != nil {
		t.Fatal(err)
	}
	if all.OutputHash != res.OutputHash {
		t.Fatal("keeping every code's rows changes the run")
	}
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
	cal := publicationCalendar(m, lag)
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

// publicationCalendar is the session calendar with the given publication lag,
// built from the market rows the way the run builds it.
func publicationCalendar(m Market, lag int) *calendar.Calendar {
	xjo := make([]civil.Date, len(m.XJO))
	for i, b := range m.XJO {
		xjo[i] = b.Date
	}
	asic := make([]civil.Date, len(m.ASIC))
	for i, r := range m.ASIC {
		asic[i] = r.ReportDate
	}
	return calendar.New(xjo, asic, lag)
}

// sessionsUpTo keeps the sessions dated on or before cut, with their decisions
// for every code the plan keeps.
func sessionsUpTo(sessions []Session, cut civil.Date) []Session {
	var out []Session
	for _, s := range sessions {
		if !s.Date.After(cut) {
			out = append(out, s)
		}
	}
	return out
}

// TestFuturePerturbation: for ten cut dates, randomising everything after the
// cut leaves the decisions, the records, the events and the trades that close
// by the cut bit-identical. The decisions are every code's status, score, pivot
// and rule inputs on every session, not only the codes that trade.
func TestFuturePerturbation(t *testing.T) {
	in := loadGolden(t)
	base := runGolden(t, in)
	baseP := planGolden(t, in)
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 10; i++ {
		k := 120 + rng.Intn(goldenSessions-240)
		cut := base.Sessions[k]
		alt := perturbAfter(t, in, cut, rng)
		gotP := planGolden(t, alt)
		got, err := simulate(gotP)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(upTo(base.Records, cut), upTo(got.Records, cut)) {
			t.Fatalf("cut %s: equity before the cut changed", cut)
		}
		if !reflect.DeepEqual(eventsUpTo(base.Events, cut), eventsUpTo(got.Events, cut)) {
			t.Fatalf("cut %s: events before the cut changed", cut)
		}
		if !reflect.DeepEqual(closedBy(base.Trades, cut), closedBy(got.Trades, cut)) {
			t.Fatalf("cut %s: trades closed by the cut changed", cut)
		}
		if !reflect.DeepEqual(sessionsUpTo(baseP.sessions, cut), sessionsUpTo(gotP.sessions, cut)) {
			t.Fatalf("cut %s: decisions before the cut changed: %s", cut, firstDecisionDiff(baseP.sessions, gotP.sessions))
		}
	}
}

// TestPublicationTiming: changing only one report's values leaves every
// decision before that report is public unchanged, and some decision on or
// after it changes. The loop over several reports must find one that crosses.
func TestPublicationTiming(t *testing.T) {
	in := loadGolden(t)
	base := runGolden(t, in)
	baseP := planGolden(t, in)
	lag := goldenSpec(t).Data.PublicationLagSessions
	cal := publicationCalendar(in.Mkt, lag)
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
		gotP := planGolden(t, &alt)
		got, err := simulate(gotP)
		if err != nil {
			t.Fatal(err)
		}
		cut := published.AddDays(-1)
		if !reflect.DeepEqual(upTo(base.Records, cut), upTo(got.Records, cut)) {
			t.Fatalf("report %s: equity before it was public (%s) changed", report, published)
		}
		if !reflect.DeepEqual(sessionsUpTo(baseP.sessions, cut), sessionsUpTo(gotP.sessions, cut)) {
			t.Fatalf("report %s: a decision before it was public (%s) changed: %s", report, published,
				firstDecisionDiff(baseP.sessions, gotP.sessions))
		}
		if !reflect.DeepEqual(baseP.sessions, gotP.sessions) {
			crossed = true
		}
	}
	if !crossed {
		t.Fatal("no report in the sample changed a later decision; the gate tests nothing")
	}
}

// firstDecisionDiff names the first session and code whose rows differ.
func firstDecisionDiff(a, b []Session) string {
	for i := range a {
		if i >= len(b) {
			return "the plans differ in length"
		}
		if reflect.DeepEqual(a[i], b[i]) {
			continue
		}
		for j := range a[i].Codes {
			if j < len(b[i].Codes) && !reflect.DeepEqual(a[i].Codes[j], b[i].Codes[j]) {
				return a[i].Date.String() + " " + a[i].Codes[j].Code
			}
		}
		return a[i].Date.String()
	}
	return ""
}

// TestStepEqualsRun is the pure form: each session is built from its own day
// the way a daily step would see it, the snapshot path's picks on that date and
// the rows dated on it, and the sessions are stepped one at a time from one
// carried state. The records and trades must equal Run's.
func TestStepEqualsRun(t *testing.T) {
	in := loadGolden(t)
	res := runGolden(t, in)
	p := planGolden(t, in)
	s := goldenSpec(t)
	strategy, ok := engine.Lookup(s.StrategyID)
	if !ok {
		t.Fatal("no strategy")
	}
	pin, mkt, err := pipelineInputs(in)
	if err != nil {
		t.Fatal(err)
	}
	idx := pipeline.NewIndex(pin, s)
	st := NewState(p.cfg)
	var prev civil.Date
	for k, ses := range p.sessions {
		d := ses.Date
		hasPrev := k > 0
		cands, stats, _ := pipeline.BuildCandidates(d, pin, s)
		for i := range cands {
			cands[i].Industry = mkt.Industry[cands[i].StockCode]
		}
		engine.PrepareCandidates(cands)
		env := engine.NewEnvFromStats(features.Regime(pin.XJO, d), stats)
		picks := map[string]engine.Pick{}
		for _, pk := range engine.EvaluateWithEnv(strategy, cands, env) {
			picks[pk.Candidate.StockCode] = pk
		}
		sess := Session{Date: d, Index: k, Seed: ses.Seed, CashRate: ses.CashRate, Benchmark: ses.Benchmark}
		for _, code := range pin.Codes {
			cs := CodeSession{Code: code, Status: string(engine.StatusNone)}
			if pk, ok := picks[code]; ok {
				cs = pickRow(code, pk)
			}
			cs.Bar = dailyBar(pin.Bars[code], d)
			cs.Dividend = dividendDuring(pin.Dividends[code], prev, d, hasPrev)
			cs.CA = suspectDuring(idx.Suspects(code), prev, d, hasPrev)
			sess.Codes = append(sess.Codes, cs)
		}
		Step(st, sess)
		prev = d
	}
	if !reflect.DeepEqual(st.Records(), res.Records) || !reflect.DeepEqual(st.Finish(), res.Trades) {
		t.Fatal("stepping the sessions by hand differs from Run")
	}
}

// pickRow is the decision a pick carries, as the simulator's row holds it.
func pickRow(code string, pk engine.Pick) CodeSession {
	c := pk.Candidate
	cs := CodeSession{
		Code:   code,
		Status: string(pk.Status),
		Score:  pk.Score,
		Pivot:  derefOr(c.BaseHigh),
		DV20:   derefOr(c.DollarVolume20d),
		SMA50:  derefOr(c.SMA50),
		SMA200: derefOr(c.SMA200),
	}
	if c.BreakoutDate != nil {
		cs.BreakoutDate = civil.DateOf(*c.BreakoutDate)
	}
	return cs
}

// decisionOnly keeps the decision fields of a row and clears the rest.
func decisionOnly(cs CodeSession) CodeSession {
	return CodeSession{Code: cs.Code, Status: cs.Status, Score: cs.Score, Pivot: cs.Pivot,
		BreakoutDate: cs.BreakoutDate, DV20: cs.DV20, SMA50: cs.SMA50, SMA200: cs.SMA200}
}

// dailyBar is the code's priced bar dated d, written independently of barOn.
func dailyBar(bars []features.Bar, d civil.Date) *features.Bar {
	for i := range bars {
		if bars[i].Date == d && features.Priced(bars[i].Close) {
			b := bars[i]
			return &b
		}
	}
	return nil
}

// dividendDuring sums the dividends with an ex-date in (prev, d]; on the first
// session it sums those on or before d.
func dividendDuring(ds []features.Dividend, prev, d civil.Date, hasPrev bool) float64 {
	sum := 0.0
	for _, x := range ds {
		if x.ExDate.After(d) || (hasPrev && !x.ExDate.After(prev)) {
			continue
		}
		sum += x.AmountPerShare
	}
	return sum
}

// suspectDuring is the suspect whose KnownAt falls in (prev, d], the earliest
// bar when several do; on the first session it takes those known on or before d.
func suspectDuring(suspects []features.CASuspect, prev, d civil.Date, hasPrev bool) CASuspect {
	var out CASuspect
	for _, s := range suspects {
		if s.KnownAt.After(d) || (hasPrev && !s.KnownAt.After(prev)) {
			continue
		}
		if !out.Known || s.Date.Before(out.SuspectDate) {
			out = CASuspect{Known: true, SuspectDate: s.Date}
		}
	}
	return out
}

// TestBacktestSessionEqualsSnapshot is the golden form: on several sessions,
// every code's decision in Run's pass 2 (the statuses, scores and rule inputs,
// built from the statistics and regime of pass 1) is the snapshot path's pick,
// field for field, and a code the snapshot does not hold has no status.
func TestBacktestSessionEqualsSnapshot(t *testing.T) {
	in := loadGolden(t)
	s := goldenSpec(t)
	strategy, ok := engine.Lookup(s.StrategyID)
	if !ok {
		t.Fatal("no strategy")
	}
	pin, mkt, err := pipelineInputs(in)
	if err != nil {
		t.Fatal(err)
	}
	p := planGolden(t, in)
	for _, k := range []int{100, 250, 400, 600} {
		ses := p.sessions[k]
		d := ses.Date
		cands, stats, _ := pipeline.BuildCandidates(d, pin, s)
		for i := range cands {
			cands[i].Industry = mkt.Industry[cands[i].StockCode]
		}
		engine.PrepareCandidates(cands)
		env := engine.NewEnvFromStats(features.Regime(pin.XJO, d), stats)
		snapshot := map[string]engine.Pick{}
		for _, pk := range engine.EvaluateWithEnv(strategy, cands, env) {
			snapshot[pk.Candidate.StockCode] = pk
		}
		rows := map[string]CodeSession{}
		for _, cs := range ses.Codes {
			rows[cs.Code] = cs
		}
		for _, code := range pin.Codes {
			got, ok := rows[code]
			if !ok {
				t.Fatalf("%s on %s: the plan keeps no rows for it", code, d)
			}
			pk, held := snapshot[code]
			if !held {
				if got.Status != string(engine.StatusNone) {
					t.Fatalf("%s on %s: the snapshot excludes it, the run reads %s", code, d, got.Status)
				}
				continue
			}
			want := pickRow(code, pk)
			if !reflect.DeepEqual(decisionOnly(got), decisionOnly(want)) {
				t.Fatalf("%s on %s: decision differs: run %+v, snapshot %+v", code, d, decisionOnly(got), decisionOnly(want))
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
	cal := calendarOf(Market{XJO: xjoOf(bars)})
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
	baseP := planGolden(t, in)
	lag := goldenSpec(t).Data.PublicationLagSessions
	report := base.Sessions[420]
	published, ok := publicationCalendar(in.Mkt, lag).PublishedOn(report)
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
	gotP := planGolden(t, &alt)
	cut := published.AddDays(-1)
	if !reflect.DeepEqual(upTo(base.Records, cut), upTo(got.Records, cut)) {
		t.Fatalf("a report public after %s changed equity before it", cut)
	}
	if !reflect.DeepEqual(sessionsUpTo(baseP.sessions, cut), sessionsUpTo(gotP.sessions, cut)) {
		t.Fatalf("a report public after %s changed a decision before it: %s", cut, firstDecisionDiff(baseP.sessions, gotP.sessions))
	}
}

// TestUpJumpConsolidationAfterResync: a tenfold up-jump after the last live
// re-sync, on a code outside the ASIC report, is no trigger, no trade and no
// phantom equity. The gate is read at the guard, not through the universe: the
// ASIC report rule is switched off so that only the corporate-action guard can
// keep the code out, and disabling that guard fails the test.
func TestUpJumpConsolidationAfterResync(t *testing.T) {
	in := loadGolden(t)
	s := goldenSpec(t)
	upjump, err := civil.ParseDate(s.Data.CAUpjumpFrom)
	if err != nil {
		t.Fatal(err)
	}
	cal := publicationCalendar(in.Mkt, s.Data.PublicationLagSessions)
	var rows []features.ASICRow
	for _, r := range in.Mkt.ASIC {
		if r.Code == "GD09" {
			rows = append(rows, r)
		}
	}
	suspects := features.CASuspects(in.BarsByCode["GD09"], rows, cal, upjump)
	var jump *features.CASuspect
	for i := range suspects {
		if suspects[i].Kind == features.CAUpjump {
			jump = &suspects[i]
		}
	}
	if jump == nil {
		t.Fatal("the consolidation is not an up-jump suspect after the re-sync")
	}

	pin, _, err := pipelineInputs(in)
	if err != nil {
		t.Fatal(err)
	}
	s.Universe.ASICReported = false
	idx := pipeline.NewIndex(pin, s)
	guarded := 0
	for _, sess := range planGolden(t, in).sessions {
		if sess.Date.Before(jump.KnownAt) || sess.Date.After(jump.Date.AddDays(400)) {
			continue
		}
		_, bad := idx.CandidateAt("GD09", sess.Date)
		if cal.SessionsBetween(jump.Date, sess.Date) < caGuardWindow && (bad == nil || bad.Reason != pipeline.ReasonCorporateActionGuard) {
			t.Fatalf("GD09 on %s is eligible within %d sessions of its up-jump", sess.Date, caGuardWindow)
		}
		if bad != nil {
			guarded++
		}
	}
	if guarded == 0 {
		t.Fatal("the guard never excluded the code; the gate tests nothing")
	}

	res := runGolden(t, in)
	for i := 1; i < len(res.Records); i++ {
		if r := res.Records[i].Equity / res.Records[i-1].Equity; r > 1.5 || r < 0.5 {
			t.Fatalf("equity moved %.2fx on %s: a phantom mark", r, res.Records[i].Date)
		}
	}
}

// caGuardWindow mirrors the pipeline's corporate-action window in sessions.
const caGuardWindow = 260

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

// insertIndexBar adds an index bar dated d, at the level of the bar before it
// raised by five per cent: a spurious level that would move the run if it were
// read. The bars stay date ascending.
func insertIndexBar(bars []features.IndexBar, d civil.Date) []features.IndexBar {
	i := sort.Search(len(bars), func(i int) bool { return bars[i].Date.After(d) })
	prev := bars[i-1]
	lvl := round4(prev.Close * 1.05)
	bar := features.IndexBar{Date: d, High: round4(lvl * 1.004), Low: round4(lvl * 0.996), Close: lvl}
	out := append([]features.IndexBar(nil), bars[:i]...)
	out = append(out, bar)
	return append(out, bars[i:]...)
}

// TestSpuriousIndexBarOnAClosedDayChangesNothing: an index bar dated on a day
// the calendar does not hold as a session, a Saturday or a holiday, reaches
// neither the regime nor the simulator. The run is the same.
func TestSpuriousIndexBarOnAClosedDayChangesNothing(t *testing.T) {
	in := loadGolden(t)
	base := runGolden(t, in)
	for _, d := range []civil.Date{{Year: 2023, Month: 6, Day: 10}, {Year: 2023, Month: 6, Day: 11}} {
		alt := *in
		alt.Mkt.XJO = insertIndexBar(in.Mkt.XJO, d)
		alt.Mkt.XJT = insertIndexBar(in.Mkt.XJT, d)
		if calendarOf(alt.Mkt).IsSession(d) {
			t.Fatalf("%s is a session of the golden calendar; the gate needs a closed day", d)
		}
		if got := runGolden(t, &alt); got.OutputHash != base.OutputHash {
			t.Fatalf("a spurious index bar on %s changed the run", d)
		}
	}
}

// TestUnpricedRowIsNoBar: a stock_prices row whose close is NULL or not
// positive is no bar for execution: the run is the one with that row absent,
// and it does not fail.
func TestUnpricedRowIsNoBar(t *testing.T) {
	in := loadGolden(t)
	day := civil.Date{Year: 2023, Month: 12, Day: 6}
	const code = "GD02"
	var idx int
	for i, b := range in.BarsByCode[code] {
		if b.Date == day {
			idx = i
		}
	}
	without := *in
	without.BarsByCode = map[string][]features.Bar{}
	for c, bars := range in.BarsByCode {
		withBars := append([]features.Bar(nil), bars...)
		if c == code {
			withBars = append(withBars[:idx:idx], withBars[idx+1:]...)
		}
		without.BarsByCode[c] = withBars
	}
	want := runGolden(t, &without).OutputHash

	for _, close := range []float64{0, math.NaN()} {
		alt := *in
		alt.BarsByCode = map[string][]features.Bar{}
		for c, bars := range in.BarsByCode {
			alt.BarsByCode[c] = bars
		}
		bars := append([]features.Bar(nil), in.BarsByCode[code]...)
		bars[idx].Close = close
		alt.BarsByCode[code] = bars
		if got := runGolden(t, &alt).OutputHash; got != want {
			t.Fatalf("an unpriced row (close %v) on %s is not the same as no row", close, day)
		}
	}
}

// TestSuspectAndExDateBetweenSessionsAreTaken: a dividend ex-dated on a closed
// day and a suspect known on one are taken on the next session, and one known
// before the first session on the first. Neither is lost, nor counted twice.
func TestSuspectAndExDateBetweenSessionsAreTaken(t *testing.T) {
	d := func(day int) civil.Date { return civil.Date{Year: 2023, Month: 6, Day: day} }
	dates := []civil.Date{d(8), d(9), d(12)} // Thu, Fri, then Monday: 10 and 11 are closed
	divs := []features.Dividend{
		{ExDate: d(10), AmountPerShare: 0.5}, // Saturday: the Monday session
		{ExDate: d(8), AmountPerShare: 0.25},
		{ExDate: d(1), AmountPerShare: 0.125}, // before the first session
	}
	if got, want := dividendsBySession(divs, dates), []float64{0.375, 0, 0.5}; !reflect.DeepEqual(got, want) {
		t.Fatalf("dividends by session %v, want %v", got, want)
	}
	suspects := []features.CASuspect{
		{Date: d(9), KnownAt: d(10), Kind: features.CAUpjump},
		{Date: d(1), KnownAt: d(2), Kind: features.CACorroborated},
		{Date: d(8), KnownAt: d(12), Kind: features.CAZeroVolume}, // earlier bar, same session
	}
	got := caBySession(suspects, dates)
	if got[0] != (CASuspect{Known: true, SuspectDate: d(1)}) {
		t.Fatalf("a suspect known before the first session: %+v, want the first session", got[0])
	}
	if got[1] != (CASuspect{}) {
		t.Fatalf("a suspect known on a closed day reported on %s: %+v", dates[1], got[1])
	}
	if got[2] != (CASuspect{Known: true, SuspectDate: d(8)}) {
		t.Fatalf("the Monday session: %+v, want the earliest bar of the two known there", got[2])
	}
}

// TestRateBeforeTheSeriesIsNone: a session before the first cash-rate point
// earns no rate, rather than one published later.
func TestRateBeforeTheSeriesIsNone(t *testing.T) {
	points := []features.RatePoint{{Date: civil.Date{Year: 2023, Month: 3, Day: 1}, Rate: 3.1}}
	if got := rateOn(points, civil.Date{Year: 2023, Month: 2, Day: 10}); got != 0 {
		t.Fatalf("a session before the series reads rate %v", got)
	}
	if got := rateOn(points, civil.Date{Year: 2023, Month: 3, Day: 2}); got != 3.1 {
		t.Fatalf("a session after the point reads rate %v", got)
	}
}

// TestRecordsStartAtTheWindow: the session before the window seeds the run but
// is neither recorded nor reported, so the equity curve starts on window_start.
func TestRecordsStartAtTheWindow(t *testing.T) {
	res := runGolden(t, loadGolden(t))
	want := civil.Date{Year: 2023, Month: 1, Day: 3}
	if len(res.Records) == 0 || res.Records[0].Date != want || res.Sessions[0] != want {
		t.Fatalf("the curve starts on %v, want %s", res.Records[0].Date, want)
	}
	if len(res.Records) != len(res.Sessions) || len(res.Eligible) != len(res.Sessions) {
		t.Fatalf("%d records, %d sessions, %d eligible counts", len(res.Records), len(res.Sessions), len(res.Eligible))
	}
}
