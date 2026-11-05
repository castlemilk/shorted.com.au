package backtest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pipeline"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Result is one run of a recipe over a version's rules.
type Result struct {
	// Sessions are the window's sessions, ascending: the calendar's sessions
	// from window_start on. The session before the window is evaluated to seed
	// each stock's last status, but it is not recorded and carries no equity.
	Sessions []civil.Date
	// Eligible counts, per session in Sessions, the codes the universe admits.
	Eligible []int
	Records  []Record
	Events   []Event
	Trades   []Trade
	Metrics  Metrics
	// OutputHash fingerprints the records, events and trades. Two runs over the
	// same inputs agree on it, whatever order the inputs arrived in.
	OutputHash string
}

// Metrics are the figures a run reports over its recorded curve and trades.
type Metrics struct {
	TotalReturn    float64
	HasTotalReturn bool
	CAGR           float64
	HasCAGR        bool
	MaxDrawdown    Drawdown
	Trades         TradeSummary
}

// plan is a run's inputs prepared for the simulator: the sessions, each carrying
// the rows of the codes that ever trigger, and the simulator's configuration.
type plan struct {
	// sessions are the calendar's sessions from the seed session on. A session
	// before the window has Seed set.
	sessions []Session
	// eligible counts, per entry of sessions, the codes the universe admits.
	eligible []int
	// universe is pass 1's statistics per entry of sessions: the values
	// pipeline.BuildCandidates gives the snapshot path on that session.
	universe []engine.UniverseStats
	// picks is pass 2's pick of every code the rules pass, per entry of
	// sessions. It is kept only when every code's rows are, nil otherwise.
	picks []map[string]engine.Pick
	cfg   Config
}

// Run runs recipe r over the rows in in under version s. It makes two passes
// over the rows. Pass 1 reads every code on every session and keeps the
// universe statistics the rules compare against: the rs_6m values of the
// eligible codes and the regime. Pass 2 reads every code again, evaluates it on
// each session with the same candidate and rule functions as the snapshot, and
// keeps the sessions of the codes that ever trigger. The simulator then runs
// session by session over those rows.
//
// Run is a function of its inputs: it reads no clock and no randomness, and
// its output does not depend on the order in which in returns the codes.
func Run(in Inputs, s spec.Spec, r spec.Recipe) (Result, error) {
	p, err := prepare(in, s, r, false)
	if err != nil {
		return Result{}, err
	}
	return simulate(p)
}

// prepare runs both passes and returns the simulator's sessions. With keepAll
// every code keeps its rows on every session, not only the codes that trigger:
// the gates compare every code's decisions with the snapshot's and across cuts.
func prepare(in Inputs, s spec.Spec, r spec.Recipe, keepAll bool) (plan, error) {
	if err := r.Validate(); err != nil {
		return plan{}, fmt.Errorf("backtest: recipe: %w", err)
	}
	if s.StrategyID != r.StrategyID {
		return plan{}, fmt.Errorf("backtest: recipe %s is for %s, not %s", r.ID, r.StrategyID, s.StrategyID)
	}
	strategy, ok := engine.Lookup(s.StrategyID)
	if !ok {
		return plan{}, fmt.Errorf("backtest: no strategy %q", s.StrategyID)
	}
	price4dp, err := civil.ParseDate(s.Data.Price4dpFrom)
	if err != nil || price4dp.IsZero() {
		return plan{}, errors.New("backtest: the version has no price_4dp_from")
	}
	windowStart, err := civil.ParseDate(r.WindowStart)
	if err != nil {
		return plan{}, fmt.Errorf("backtest: window_start: %w", err)
	}

	// The inputs are read once: the bars are held for both passes.
	pin, mkt, err := pipelineInputs(in)
	if err != nil {
		return plan{}, err
	}
	codes, bars := pin.Codes, pin.Bars
	idx := pipeline.NewIndex(pin, s)

	// The sessions are the calendar's, read off the index dates. The index bars
	// the regime and the RS probes read are the stored rows, whatever the
	// calendar makes of their dates: the snapshot path reads the same rows.
	cal := idx.Calendar()
	var dates []civil.Date
	for _, b := range mkt.XJO {
		if cal.IsSession(b.Date) {
			dates = append(dates, b.Date)
		}
	}
	n := len(dates)
	seed := make([]bool, n)
	for k, t := range dates {
		seed[k] = t.Before(windowStart)
	}
	// The window's first session needs one session before it to seed statuses.
	from := sort.Search(n, func(i int) bool { return !dates[i].Before(windowStart) }) - 1
	if from < 0 {
		from = 0
	}
	dates, seed = dates[from:], seed[from:]
	n = len(dates)
	if n == 0 {
		return plan{}, errors.New("backtest: no sessions in the window")
	}

	// Pass 1: the universe statistics and regime of every session. The
	// statistics are the eligible codes' own, read by the function the snapshot
	// path uses.
	envs := make([]*engine.Env, n)
	universe := make([]engine.UniverseStats, n)
	eligible := make([]int, n)
	for k, t := range dates {
		regime := features.Regime(mkt.XJO, t)
		var cands []engine.Candidate
		for _, code := range codes {
			c, bad := idx.CandidateAt(code, t)
			if bad != nil {
				continue
			}
			cands = append(cands, c)
		}
		eligible[k] = len(cands)
		universe[k] = engine.UniverseStatsOf(cands)
		universe[k].Session = t
		envs[k] = engine.NewEnvFromStats(regime, universe[k])
	}

	// Pass 2: each code on each session. Only the codes that ever trigger keep
	// their rows, unless keepAll: no other code can hold a position or enter one.
	var picks []map[string]engine.Pick
	if keepAll {
		picks = make([]map[string]engine.Pick, n)
		for k := range picks {
			picks[k] = map[string]engine.Pick{}
		}
	}
	kept := make([][]CodeSession, 0)
	keptCodes := make([]string, 0)
	for _, code := range codes {
		rows := make([]CodeSession, n)
		triggered := false
		caKnown := caBySession(idx.Suspects(code), dates, cal)
		divAt := dividendsBySession(pin.Dividends[code], dates)
		for k, t := range dates {
			cs := CodeSession{Code: code, Status: string(engine.StatusNone)}
			cand, bad := idx.CandidateAt(code, t)
			if bad == nil {
				cand.Industry = mkt.Industry[code]
				cands := []engine.Candidate{cand}
				engine.PrepareCandidates(cands)
				cand = cands[0]
				pick, ok := engine.EvaluateOne(strategy, cand, envs[k])
				if ok && keepAll {
					picks[k][code] = pick
				}
				cs.Status = string(pick.Status)
				cs.Score = pick.Score
				cs.Pivot = derefOr(cand.BaseHigh)
				cs.DV20 = derefOr(cand.DollarVolume20d)
				cs.SMA50 = derefOr(cand.SMA50)
				cs.SMA200 = derefOr(cand.SMA200)
				if cand.BreakoutDate != nil {
					cs.BreakoutDate = civil.DateOf(*cand.BreakoutDate)
				}
			}
			cs.Bar = barOn(bars[code], t)
			cs.Dividend = divAt[k]
			cs.CA = caKnown[k]
			rows[k] = cs
			if cs.Status == statusTriggered {
				triggered = true
			}
		}
		if triggered || keepAll {
			kept = append(kept, rows)
			keptCodes = append(keptCodes, code)
		}
	}

	sessions := make([]Session, n)
	for k, t := range dates {
		sessions[k] = Session{
			Date:      t,
			Index:     k,
			Seed:      seed[k],
			CashRate:  rateOn(mkt.CashRate, t) / 100,
			Benchmark: levelOn(mkt.XJT, t),
			Codes:     make([]CodeSession, 0, len(keptCodes)),
		}
	}
	for i := range keptCodes {
		for k := range dates {
			sessions[k].Codes = append(sessions[k].Codes, kept[i][k])
		}
	}

	// The window's eligible counts, one per recorded session.
	var windowEligible []int
	for k := range dates {
		if !seed[k] {
			windowEligible = append(windowEligible, eligible[k])
		}
	}

	cfg := ConfigOf(r)
	cfg.Price4dpFrom = price4dp
	cfg.LastLoaded = make(map[string]civil.Date, len(codes))
	for _, code := range codes {
		if last, ok := lastPriced(bars[code]); ok {
			cfg.LastLoaded[code] = last
		}
	}
	return plan{sessions: sessions, eligible: windowEligible, universe: universe, picks: picks, cfg: cfg}, nil
}

// pipelineInputs reads the window's rows once into the pipeline's form: the
// codes sorted and unique, their bars checked for order, and the market rows,
// all as stored. Run and the tests that compare it with the snapshot path build
// their candidates from the same value.
func pipelineInputs(in Inputs) (*pipeline.Inputs, Market, error) {
	codes := append([]string(nil), in.Codes()...)
	sort.Strings(codes)
	mkt := in.Market()
	if len(mkt.XJO) == 0 {
		return nil, Market{}, errors.New("backtest: no index bars")
	}
	pin := &pipeline.Inputs{
		Codes:        codes,
		Bars:         make(map[string][]features.Bar, len(codes)),
		XJO:          mkt.XJO,
		XJT:          mkt.XJT,
		ASIC:         mkt.ASIC,
		Ingests:      mkt.Ingests,
		ETPSet:       mkt.ETPs,
		Names:        mkt.Names,
		CashRate:     mkt.CashRate,
		Dividends:    make(map[string][]features.Dividend, len(codes)),
		Fundamentals: make(map[string]features.Fundamentals, len(codes)),
	}
	for i, code := range codes {
		if i > 0 && codes[i-1] == code {
			return nil, Market{}, fmt.Errorf("backtest: code %s appears twice", code)
		}
		b := in.Bars(code)
		for j := 1; j < len(b); j++ {
			if !b[j-1].Date.Before(b[j].Date) {
				return nil, Market{}, fmt.Errorf("backtest: %s bars are not strictly date ascending at %s", code, b[j].Date)
			}
		}
		pin.Bars[code] = b
		pin.Dividends[code] = in.Dividends(code)
		pin.Fundamentals[code] = in.Fundamentals(code)
	}
	return pin, mkt, nil
}

// simulate runs the simulator over the plan's sessions and reports the run.
func simulate(p plan) (Result, error) {
	st := NewState(p.cfg)
	for _, s := range p.sessions {
		Step(st, s)
	}
	trades := st.Finish()
	recs := st.Records()
	events := st.Events()
	hash, err := outputHash(recs, events, trades)
	if err != nil {
		return Result{}, err
	}
	curve := EquityCurve(recs)
	res := Result{
		Eligible:   p.eligible,
		Records:    recs,
		Events:     events,
		Trades:     trades,
		OutputHash: hash,
		Metrics: Metrics{
			MaxDrawdown: MaxDrawdown(curve),
			Trades:      Summarise(trades),
		},
	}
	for _, s := range p.sessions {
		if !s.Seed {
			res.Sessions = append(res.Sessions, s.Date)
		}
	}
	res.Metrics.TotalReturn, res.Metrics.HasTotalReturn = TotalReturn(curve)
	res.Metrics.CAGR, res.Metrics.HasCAGR = CAGR(curve)
	return res, nil
}

// outputHash fingerprints what a run reports. encoding/json writes floats in
// their shortest round-trip form, so equal runs hash equal.
func outputHash(recs []Record, events []Event, trades []Trade) (string, error) {
	b, err := json.Marshal(struct {
		Records []Record
		Events  []Event
		Trades  []Trade
	}{recs, events, trades})
	if err != nil {
		return "", fmt.Errorf("backtest: hashing the output: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func derefOr(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// barOn is the code's priced bar dated t, nil when it has none. An unpriced row
// (a NULL or non-positive close) is no bar for execution: it marks nothing and
// fills nothing, as a missing row does. The copy keeps the session rows
// independent of the inputs.
func barOn(bars []features.Bar, t civil.Date) *features.Bar {
	i := sort.Search(len(bars), func(i int) bool { return !bars[i].Date.Before(t) })
	if i < len(bars) && bars[i].Date == t && features.Priced(bars[i].Close) {
		b := bars[i]
		return &b
	}
	return nil
}

// lastPriced is the date of the last priced bar.
func lastPriced(bars []features.Bar) (civil.Date, bool) {
	for i := len(bars) - 1; i >= 0; i-- {
		if features.Priced(bars[i].Close) {
			return bars[i].Date, true
		}
	}
	return civil.Date{}, false
}

// dividendsBySession sums a code's cash dividends by the session they are
// registered on: the first session on or after the ex-date, so an ex-date that
// falls on a closed day is credited on the next session. An ex-date before the
// first session is credited on the first.
func dividendsBySession(ds []features.Dividend, dates []civil.Date) []float64 {
	out := make([]float64, len(dates))
	for _, d := range ds {
		k := sort.Search(len(dates), func(i int) bool { return !dates[i].Before(d.ExDate) })
		if k < len(dates) {
			out[k] += d.AmountPerShare
		}
	}
	return out
}

// caBySession reports, per session, the corporate-action suspect that becomes
// known on it: a suspect is known on the first session on or after its KnownAt,
// so one dated between sessions is never lost. When several are known on the
// same session, the earliest bar is the one reported. A position entered before
// that bar is the one the exclusion closes.
//
// A suspect known before the first session is known on that session with its
// age: the sessions from its known date to the first session. The block on new
// entries counts from the known date, so a suspect older than the block is
// dropped, and of several the most recent one sets the block. Nothing can be
// held across such a suspect: no position is entered before the first session.
func caBySession(suspects []features.CASuspect, dates []civil.Date, cal *calendar.Calendar) []CASuspect {
	out := make([]CASuspect, len(dates))
	for _, s := range suspects {
		k := sort.Search(len(dates), func(i int) bool { return !dates[i].Before(s.KnownAt) })
		if k == len(dates) {
			continue
		}
		if k == 0 && s.KnownAt.Before(dates[0]) {
			age := sessionsBefore(cal, s.KnownAt, dates[0], caBlockSessions+1)
			if age > caBlockSessions {
				continue
			}
			if !out[0].Known || age < out[0].Age {
				out[0] = CASuspect{Known: true, SuspectDate: s.Date, Age: age}
			}
			continue
		}
		if !out[k].Known || s.Date.Before(out[k].SuspectDate) {
			out[k] = CASuspect{Known: true, SuspectDate: s.Date}
		}
	}
	return out
}

// sessionsBefore counts the sessions s with from <= s < to, and stops counting
// once the count exceeds limit.
func sessionsBefore(cal *calendar.Calendar, from, to civil.Date, limit int) int {
	n := 0
	for d := from; d.Before(to) && n <= limit; d = d.AddDays(1) {
		if cal.IsSession(d) {
			n++
		}
	}
	return n
}

// rateOn is the cash rate in force on t: the newest point on or before t. Zero
// when no point is on or before t, so a session before the series starts earns
// no interest rather than a rate published later.
func rateOn(points []features.RatePoint, t civil.Date) float64 {
	i := sort.Search(len(points), func(i int) bool { return points[i].Date.After(t) }) - 1
	if i < 0 {
		return 0
	}
	return points[i].Rate
}

// levelOn is the index level on t, or the newest before it. Zero before the
// first bar.
func levelOn(bars []features.IndexBar, t civil.Date) float64 {
	i := sort.Search(len(bars), func(i int) bool { return bars[i].Date.After(t) }) - 1
	if i < 0 {
		return 0
	}
	return bars[i].Close
}
