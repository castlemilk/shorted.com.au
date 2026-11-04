// Package pipeline turns stored rows into the candidates the engine evaluates.
// Inputs is the one set of rows a run reads; CandidateAt and BuildCandidates
// apply the universe rules to them. Only the types and signatures are final
// here: the universe rules are added with the candidate builder.
package pipeline

import (
	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Inputs is the set of rows one run reads. Iteration is over Codes, which is
// sorted; the maps are keyed by stock code and are never ranged over for output.
type Inputs struct {
	Codes  []string                  // sorted; the only iteration order
	Bars   map[string][]features.Bar // per code, date ascending, px-filtered by the reader
	XJO    []features.IndexBar       // regime, RS
	XJT    []features.IndexBar       // benchmark
	ETPSet map[string]bool           // ETF and LIC codes, the universe's exclusion list
	Names  map[string]string         // company names, for the ordinary-share rule
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
