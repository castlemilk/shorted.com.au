package spec

// Strategy ids, as the engine names them. TestV0SpecMatchesCode checks these
// against engine.ID*.
const (
	StrategyZangerBreakout       = "zanger-breakout"
	StrategyCANSLIM              = "canslim"
	StrategyMinerviniTrend       = "minervini-trend-template"
	StrategyCrowdedShortBreakout = "crowded-short-breakout"
	StrategyQualityCompounders   = "quality-compounders"
)

// Registered is one canonical version of a strategy as the product publishes
// it. The label, the changelog, the known issues and the live flag are NOT in
// the hash: only Spec is.
type Registered struct {
	// Label names the version ("v0", "v1", ...).
	Label string
	// Spec is the version's rules. Its hash is the version's identity.
	Spec Spec
	// Live marks the version the engine evaluates now. Exactly one registered
	// version per strategy is live.
	Live bool
	// Changes lists what this version changed from the one before it.
	Changes []string
	// KnownIssues lists what the version gets wrong, worded as defects.
	KnownIssues []string
	// Recipe is the execution recipe backtests of this version trade with, or
	// nil while none is registered (v0 is never backtested). Its hash is stored
	// apart from the rules hash, and it is not part of Spec.
	Recipe *Recipe
}

// Registry returns every canonical version ever published, in publication
// order within each strategy, freshly allocated on every call so the caller
// may not mutate the shared definitions.
func Registry() []Registered {
	out := make([]Registered, 0, 5)
	for _, id := range strategyOrder {
		out = append(out, v0(id))
	}
	return out
}

// Live returns the version the engine evaluates for a strategy.
func Live(strategyID string) (Registered, bool) {
	for _, r := range Registry() {
		if r.Live && r.Spec.StrategyID == strategyID {
			return r, true
		}
	}
	return Registered{}, false
}

// ByHash returns the registered version with the given rules hash.
func ByHash(hash string) (Registered, bool) {
	for _, r := range Registry() {
		h, err := RulesHash(r.Spec)
		if err == nil && h == hash {
			return r, true
		}
	}
	return Registered{}, false
}

// strategyOrder is the registry order of the five strategies: the four launch
// strategies, then quality compounders.
var strategyOrder = []string{
	StrategyZangerBreakout,
	StrategyCANSLIM,
	StrategyMinerviniTrend,
	StrategyCrowdedShortBreakout,
	StrategyQualityCompounders,
}
