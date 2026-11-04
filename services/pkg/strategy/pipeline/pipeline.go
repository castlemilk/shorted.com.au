// Package pipeline turns stored rows into the candidates the engine evaluates.
// Inputs is the one set of rows a run reads; CandidateAt and BuildCandidates
// apply the universe rules to them. The types and signatures are final here;
// the universe rules are added with the candidate builder.
package pipeline

import (
	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Inputs is the set of rows one run reads. Iteration is over Codes, which is
// sorted; the maps are keyed by stock code and are never ranged over for output.
// The readers that fill each field are pgsource's (PR-09c); the fields are
// fixed here so that the backtest is written against them.
//
// Bars are each code's stock_prices rows as stored, date ascending, with no
// close filter: unpriced closes and zero volume are kept. AsOf, DaysToCover
// and CASuspects drop the rows whose close fails validPrice themselves, while
// DaysToCoverV0 reads the rows as 000080 does, so a reader or backtest must not
// filter them before they reach the features.
type Inputs struct {
	Codes        []string                         // sorted; the only iteration order
	Bars         map[string][]features.Bar        // per code, date ascending, unfiltered (see above)
	XJO          []features.IndexBar              // regime, RS
	XJT          []features.IndexBar              // benchmark
	ASIC         []features.ASICRow               // shorts rows for the report dates needed, zero rows included
	Ingests      []features.ReportIngest          // asic_report_ingests: report completeness
	ETPSet       map[string]bool                  // ETF and LIC codes, the universe's exclusion list
	Names        map[string]string                // company names, for the ordinary-share rule
	Dividends    map[string][]features.Dividend   // per code, dividend_history: unadjusted ex-dates
	CashRate     []features.RatePoint             // the cash rate target, forward-filled
	Fundamentals map[string]features.Fundamentals // live: the fundamentals blob per code
}

// Ineligible records a code the universe excluded on a session and why.
type Ineligible struct {
	Code   string
	Reason string
}

// CandidateAt builds the candidate of one code on session t from in. Not yet
// implemented: it panics rather than return a candidate that skipped the
// universe rules.
func CandidateAt(code string, t civil.Date, in *Inputs) (engine.Candidate, *Ineligible) {
	panic("pipeline: CandidateAt is not implemented yet")
}

// BuildCandidates builds every eligible candidate on session D under the
// version s, with the statistics the rules read across the universe. Not yet
// implemented, for the same reason as CandidateAt.
func BuildCandidates(D civil.Date, in *Inputs, s spec.Spec) ([]engine.Candidate, engine.UniverseStats, []Ineligible) {
	panic("pipeline: BuildCandidates is not implemented yet")
}
