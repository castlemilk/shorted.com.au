package backtest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pipeline"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Result is one run of a recipe over a version's rules.
type Result struct {
	// Sessions are the evaluated sessions, ascending. The first is the session
	// before the window start, which is evaluated so that a stock already
	// triggered on the window's first session does not enter.
	Sessions []civil.Date
	// Eligible counts, per session, the codes the universe admits.
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
	sessions []Session
	eligible []int
	cfg      Config
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
	p, err := prepare(in, s, r)
	if err != nil {
		return Result{}, err
	}
	return simulate(p)
}

// prepare runs both passes and returns the simulator's sessions.
func prepare(in Inputs, s spec.Spec, r spec.Recipe) (plan, error) {
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

	pin, err := pipelineInputs(in)
	if err != nil {
		return plan{}, err
	}
	codes, bars := pin.Codes, pin.Bars
	idx := pipeline.NewIndex(pin, s)
	market := in.Market()
	divs := make(map[string]map[civil.Date]float64, len(codes))
	for _, code := range codes {
		divs[code] = dividendsByDate(pin.Dividends[code])
	}

	// The evaluated sessions run from the session before the window start.
	from := sort.Search(len(market.XJO), func(i int) bool { return !market.XJO[i].Date.Before(windowStart) }) - 1
	if from < 0 {
		from = 0
	}
	dates := make([]civil.Date, 0, len(market.XJO)-from)
	for _, b := range market.XJO[from:] {
		dates = append(dates, b.Date)
	}
	n := len(dates)

	// Pass 1: the universe statistics and regime of every session.
	regimes := make([]engine.Regime, n)
	stats := make([]engine.UniverseStats, n)
	eligible := make([]int, n)
	for k, t := range dates {
		regimes[k] = features.Regime(market.XJO, t)
		var rs []float64
		for _, code := range codes {
			c, bad := idx.CandidateAt(code, t)
			if bad != nil {
				continue
			}
			eligible[k]++
			if c.RS6mPct != nil {
				rs = append(rs, *c.RS6mPct)
			}
		}
		sort.Float64s(rs)
		stats[k] = engine.UniverseStats{Session: t, RS6m: rs}
	}

	// Pass 2: each code on each session. Only the codes that ever trigger keep
	// their rows: no other code can hold a position or enter one.
	kept := make([][]CodeSession, 0)
	keptCodes := make([]string, 0)
	for _, code := range codes {
		rows := make([]CodeSession, n)
		triggered := false
		suspects := idx.Suspects(code)
		for k, t := range dates {
			cs := CodeSession{Code: code, Status: string(engine.StatusNone)}
			cand, bad := idx.CandidateAt(code, t)
			if bad == nil {
				cands := []engine.Candidate{cand}
				engine.PrepareCandidates(cands)
				cand = cands[0]
				pick, _ := engine.EvaluateOne(strategy, cand, engine.NewEnvFromStats(regimes[k], stats[k]))
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
			cs.Dividend = divs[code][t]
			cs.CA = caOn(suspects, t)
			rows[k] = cs
			if cs.Status == statusTriggered {
				triggered = true
			}
		}
		if triggered {
			kept = append(kept, rows)
			keptCodes = append(keptCodes, code)
		}
	}

	sessions := make([]Session, n)
	for k, t := range dates {
		sessions[k] = Session{
			Date:      t,
			Index:     k,
			CashRate:  rateOn(market.CashRate, t) / 100,
			Benchmark: levelOn(market.XJT, t),
			Codes:     make([]CodeSession, 0, len(keptCodes)),
		}
	}
	for i := range keptCodes {
		for k := range dates {
			sessions[k].Codes = append(sessions[k].Codes, kept[i][k])
		}
	}

	cfg := ConfigOf(r)
	cfg.Price4dpFrom = price4dp
	cfg.LastLoaded = make(map[string]civil.Date, len(codes))
	for _, code := range codes {
		if b := bars[code]; len(b) > 0 {
			cfg.LastLoaded[code] = b[len(b)-1].Date
		}
	}
	return plan{sessions: sessions, eligible: eligible, cfg: cfg}, nil
}

// pipelineInputs reads the window's rows into the pipeline's form: the codes
// sorted and unique, their bars checked for order, and the market rows. Run and
// the tests that compare it with the snapshot path build their candidates from
// the same value.
func pipelineInputs(in Inputs) (*pipeline.Inputs, error) {
	codes := append([]string(nil), in.Codes()...)
	sort.Strings(codes)
	mkt := in.Market()
	if len(mkt.XJO) == 0 {
		return nil, errors.New("backtest: no index bars")
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
			return nil, fmt.Errorf("backtest: code %s appears twice", code)
		}
		b := in.Bars(code)
		for j := 1; j < len(b); j++ {
			if !b[j-1].Date.Before(b[j].Date) {
				return nil, fmt.Errorf("backtest: %s bars are not strictly date ascending at %s", code, b[j].Date)
			}
		}
		pin.Bars[code] = b
		pin.Dividends[code] = in.Dividends(code)
		pin.Fundamentals[code] = in.Fundamentals(code)
	}
	return pin, nil
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
		Sessions:   make([]civil.Date, len(p.sessions)),
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
	for k, s := range p.sessions {
		res.Sessions[k] = s.Date
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

// barOn is the code's bar dated t, nil when it has none. The copy keeps the
// session rows independent of the inputs.
func barOn(bars []features.Bar, t civil.Date) *features.Bar {
	i := sort.Search(len(bars), func(i int) bool { return !bars[i].Date.Before(t) })
	if i < len(bars) && bars[i].Date == t {
		b := bars[i]
		return &b
	}
	return nil
}

// dividendsByDate sums a code's cash dividends by ex-date.
func dividendsByDate(ds []features.Dividend) map[civil.Date]float64 {
	out := make(map[civil.Date]float64, len(ds))
	for _, d := range ds {
		out[d.ExDate] += d.AmountPerShare
	}
	return out
}

// caOn is the corporate-action suspect a code's session reports: the one whose
// KnownAt is t, the earliest bar when several are known that day. A position
// entered before that bar is the one the exclusion closes.
func caOn(suspects []features.CASuspect, t civil.Date) CASuspect {
	var out CASuspect
	for _, s := range suspects {
		if s.KnownAt != t {
			continue
		}
		if !out.Known || s.Date.Before(out.SuspectDate) {
			out = CASuspect{Known: true, SuspectDate: s.Date}
		}
	}
	return out
}

// rateOn is the cash rate in force on t: the newest point on or before t, or
// the first point before any is due. Zero when there are none.
func rateOn(points []features.RatePoint, t civil.Date) float64 {
	if len(points) == 0 {
		return 0
	}
	i := sort.Search(len(points), func(i int) bool { return points[i].Date.After(t) }) - 1
	if i < 0 {
		i = 0
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
