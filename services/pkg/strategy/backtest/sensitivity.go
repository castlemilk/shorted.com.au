package backtest

import (
	"fmt"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The sensitivity runs a published run stores. Each one changes a single
// assumption of the canonical run and re-simulates; none of them changes the
// canonical result.
const (
	SensCostsX2       = "costs_x2"
	SensASICLagPlus2  = "asic_lag_plus_2"
	SensDelistingZero = "delisting_zero"
	SensEntryPlus1    = "entry_plus_1"
	SensFlatMockup    = "flat_mockup_costs"
)

// Fragility flags. A result whose excess CAGR over the benchmark is positive in
// the base run and at or below zero under one of the three timing and cost
// sensitivities carries the matching flag.
const (
	FragileCosts            = "costs"
	FragilePublicationTime  = "publication_timing"
	FragileEntryTiming      = "entry_timing"
	asicLagExtraSessions    = 2
	entryLagSessionsVariant = 1
	flatMockupBps           = 5
)

// Labels are the copy a sensitivity is shown under. The chips are the copy of
// the fragility flag, as the Backtest tab prints it.
var sensitivityLabels = map[string]string{
	SensCostsX2:       "Costs doubled",
	SensASICLagPlus2:  "ASIC publication two sessions later",
	SensDelistingZero: "Delisted positions exit at zero",
	SensEntryPlus1:    "Entry one session later",
	SensFlatMockup:    "Mockup costs (flat 10 + 5 bps per side) flatter small-cap breakouts",
}

// FragileChip is the chip a fragility flag shows.
func FragileChip(flag string) string {
	switch flag {
	case FragileCosts:
		return "Fragile to costs"
	case FragilePublicationTime:
		return "Fragile to publication timing"
	case FragileEntryTiming:
		return "Fragile to entry timing"
	}
	return ""
}

// Figures are a run's headline figures over its recorded sessions.
type Figures struct {
	TotalReturn    float64
	HasTotalReturn bool
	CAGR           float64
	HasCAGR        bool
	MaxDrawdown    float64
	ClosedTrades   int
	// Excess is the CAGR over the benchmark on the same sessions, when both are
	// annualised.
	Excess    float64
	HasExcess bool
}

// Sensitivity is one sensitivity run next to the canonical run.
type Sensitivity struct {
	ID    string
	Label string
	// Applies is false when the recipe does not take the change; Reason says so.
	Applies bool
	Reason  string
	Figures Figures
	// Fragile is the flag a sign flip sets, empty when none is set.
	Fragile string
}

// Sensitivities are the five sensitivity runs of a canonical run, in the table's
// order.
type Sensitivities struct {
	Base Figures
	Runs []Sensitivity
}

// figuresOf summarises a run.
func figuresOf(res Result) Figures {
	curve := EquityCurve(res.Records)
	f := Figures{MaxDrawdown: res.Metrics.MaxDrawdown.Depth, ClosedTrades: res.Metrics.Trades.Closed}
	f.TotalReturn, f.HasTotalReturn = TotalReturn(curve)
	f.CAGR, f.HasCAGR = CAGR(curve)
	if bench, ok := benchmarkCurve(res.Records); ok {
		if bc, ok := CAGR(bench); ok && f.HasCAGR {
			f.Excess, f.HasExcess = f.CAGR-bc, true
		}
	}
	return f
}

// benchmarkCurve is the benchmark level of the recorded sessions. It is false
// when a session has no level, so no excess can be measured.
func benchmarkCurve(recs []Record) (Curve, bool) {
	c := Curve{Dates: make([]civil.Date, 0, len(recs)), Values: make([]float64, 0, len(recs))}
	for _, r := range recs {
		if !(r.Benchmark > 0) {
			return Curve{}, false
		}
		c.Dates = append(c.Dates, r.Date)
		c.Values = append(c.Values, r.Benchmark)
	}
	return c, true
}

// flagFor sets the fragility flag of a sensitivity: the base excess is positive
// and the variant's is at or below zero. Both must be annualised.
func flagFor(id string, base, variant Figures) string {
	if !base.HasExcess || !variant.HasExcess || !(base.Excess > 0) || variant.Excess > 0 {
		return ""
	}
	switch id {
	case SensCostsX2:
		return FragileCosts
	case SensASICLagPlus2:
		return FragilePublicationTime
	case SensEntryPlus1:
		return FragileEntryTiming
	}
	return ""
}

// RunSensitivities runs the five sensitivities of recipe r under version s over
// the rows in in, next to the canonical run. The simulator-level changes reuse
// the canonical pass 1 and pass 2; the publication lag changes what pass 1 reads
// and is re-prepared, and it applies only to the Crowded-Short recipe.
func RunSensitivities(in Inputs, s spec.Spec, r spec.Recipe) (Sensitivities, error) {
	p, err := prepare(in, s, r, false)
	if err != nil {
		return Sensitivities{}, err
	}
	base, err := simulate(p)
	if err != nil {
		return Sensitivities{}, err
	}
	return sensitivitiesOf(in, s, r, p, base)
}

// sensitivitiesOf is RunSensitivities over a canonical run already prepared and
// simulated: p is its plan and base its result.
func sensitivitiesOf(in Inputs, s spec.Spec, r spec.Recipe, p plan, base Result) (Sensitivities, error) {
	out := Sensitivities{Base: figuresOf(base)}

	variant := func(id string, cfg Config) error {
		q := p
		q.cfg = cfg
		res, err := simulate(q)
		if err != nil {
			return fmt.Errorf("backtest: sensitivity %s: %w", id, err)
		}
		f := figuresOf(res)
		out.Runs = append(out.Runs, Sensitivity{
			ID: id, Label: sensitivityLabels[id], Applies: true,
			Figures: f, Fragile: flagFor(id, out.Base, f),
		})
		return nil
	}

	cfg := p.cfg
	cfg.Costs = copyCosts(p.cfg.Costs)
	cfg.Costs.Multiplier *= 2
	if err := variant(SensCostsX2, cfg); err != nil {
		return Sensitivities{}, err
	}

	if r.StrategyID == spec.StrategyCrowdedShortBreakout {
		lagged := s
		lagged.Data.PublicationLagSessions += asicLagExtraSessions
		q, err := prepare(in, lagged, r, false)
		if err != nil {
			return Sensitivities{}, fmt.Errorf("backtest: sensitivity %s: %w", SensASICLagPlus2, err)
		}
		res, err := simulate(q)
		if err != nil {
			return Sensitivities{}, fmt.Errorf("backtest: sensitivity %s: %w", SensASICLagPlus2, err)
		}
		f := figuresOf(res)
		out.Runs = append(out.Runs, Sensitivity{
			ID: SensASICLagPlus2, Label: sensitivityLabels[SensASICLagPlus2], Applies: true,
			Figures: f, Fragile: flagFor(SensASICLagPlus2, out.Base, f),
		})
	} else {
		out.Runs = append(out.Runs, Sensitivity{
			ID: SensASICLagPlus2, Label: sensitivityLabels[SensASICLagPlus2],
			Reason: "applies to the Crowded-Short recipe only",
		})
	}

	cfg = p.cfg
	cfg.DelistingAtZero = true
	if err := variant(SensDelistingZero, cfg); err != nil {
		return Sensitivities{}, err
	}

	cfg = p.cfg
	cfg.EntryLagSessions = entryLagSessionsVariant
	if err := variant(SensEntryPlus1, cfg); err != nil {
		return Sensitivities{}, err
	}

	cfg = p.cfg
	cfg.Costs = copyCosts(p.cfg.Costs)
	flat := float64(flatMockupBps)
	cfg.Costs.FlatSlippageBps = &flat
	if err := variant(SensFlatMockup, cfg); err != nil {
		return Sensitivities{}, err
	}

	// Keep the table's order: costs, publication, delisting, entry, flat.
	order := []string{SensCostsX2, SensASICLagPlus2, SensDelistingZero, SensEntryPlus1, SensFlatMockup}
	sorted := make([]Sensitivity, 0, len(order))
	for _, id := range order {
		for _, run := range out.Runs {
			if run.ID == id {
				sorted = append(sorted, run)
			}
		}
	}
	out.Runs = sorted
	return out, nil
}
