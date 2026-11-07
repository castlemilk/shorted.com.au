// Package spec is the versioned rule set of the strategy engine: what each
// strategy tests and with which numbers, as data. A Spec is canonical when it
// is one of the versions the product publishes; its canonical JSON is hashed,
// and the hash names the version everywhere it is shown.
//
// The package is standard library only (the purity rules of the engine apply
// to it). It does not import the engine: the engine's own tests pin the specs
// here to the constants it evaluates with.
package spec

// SchemaVersion is the layout of Spec. A change to the layout bumps it, which
// changes every hash.
const SchemaVersion = 1

// EngineMajor is the engine major version the specs in this package describe.
// The engine test suite pins it to engine.Major.
const EngineMajor = 1

// Spec is one version of a strategy's rules. Field order is the canonical
// encoding's field order, so reordering or renaming a field changes every hash.
type Spec struct {
	Schema      int          `json:"schema"`         // SchemaVersion
	EngineMajor int          `json:"engine_major"`   // EngineMajor; a semantic engine change makes new hashes
	StrategyID  string       `json:"strategy_id"`    // slug; one meaning forever
	Kind        string       `json:"kind"`           // "canonical" | "variant"
	Base        string       `json:"base,omitempty"` // parent rules hash (variants)
	FeatureSet  string       `json:"feature_set"`    // "fs1"
	Features    FeatureSpec  `json:"features"`
	Universe    UniverseSpec `json:"universe"`
	Data        DataPolicy   `json:"data"`
	Regime      RegimeSpec   `json:"regime"`
	Rules       []RuleSpec   `json:"rules"` // registry order
	Ladder      LadderSpec   `json:"ladder"`
	Score       ScoreSpec    `json:"score"`
	Requires    []DataReq    `json:"requires"` // drives "Not computable before"
}

// Kind values.
const (
	KindCanonical = "canonical"
	KindVariant   = "variant"
)

// FeatureSpec holds the feature set's parameters. The fs1 keys are the SQL
// literals of migrations 000130 and 000080, pinned by a test.
type FeatureSpec struct {
	Params map[string]float64 `json:"params"`
}

// UniverseSpec says which instruments are candidates and how fresh they must be.
type UniverseSpec struct {
	Instruments  string `json:"instruments"`   // "all" (v0) | "ordinary" (v1)
	Freshness    string `json:"freshness"`     // "none" (v0) | "bar_on_session" (v1)
	MinSessions  int    `json:"min_sessions"`  // 60
	LookbackDays int    `json:"lookback_days"` // 400
	ASICReported bool   `json:"asic_reported"` // v1 Crowded-Short only: in the latest complete published report
	CAGuard      bool   `json:"ca_guard"`      // v1: corroborated corporate-action exclusion
	RSPopulation string `json:"rs_population"` // "candidates" (v0) | "universe" (v1)
}

// DataPolicy says how short positions and days to cover are read.
type DataPolicy struct {
	ShortSource            string `json:"short_source"`             // "latest_nonzero_row" (v0) | "latest_complete_published" (v1)
	PublicationLagSessions int    `json:"publication_lag_sessions"` // 0 (v0), 4 (v1)
	MaxReportAgeSessions   int    `json:"max_report_age_sessions"`  // 0 (v0: no age limit), 8 (v1)
	Calendar               string `json:"calendar"`                 // "asxcalendar" (v0, display only) | "xjo_and_asic_dates" (v1)
	DTC                    string `json:"dtc"`                      // "v0_35d_nonzero_bigint" | "v1_20_bars_min10_traded"
	Absent                 string `json:"absent"`                   // "fail"
	Fundamentals           string `json:"fundamentals"`             // "live_snapshot"
	Price4dpFrom           string `json:"price_4dp_from"`           // v1: the day 000131 was applied
	CAUpjumpFrom           string `json:"ca_upjump_from"`           // v1: the day after the last live price re-sync
}

// RegimeSpec names the index that sets the market regime and its averages.
type RegimeSpec struct {
	Index   string `json:"index"`
	SMAFast int    `json:"sma_fast"`
	SMASlow int    `json:"sma_slow"`
}

// RuleSpec is one rule of a strategy as the version tests it. The rule id has
// one evaluation function in the engine, so Params keys are fixed per id.
type RuleSpec struct {
	ID      string             `json:"id"`
	Core    bool               `json:"core"`
	Trigger bool               `json:"trigger"`
	Weight  float64            `json:"weight"`
	Params  map[string]float64 `json:"params"`
	Far     float64            `json:"far,omitempty"` // proximity distance for trigger rules, in Unit
	Unit    string             `json:"unit"`          // unit of the tested value: pct|pp|aud|days|x|bool
	Compare string             `json:"compare"`       // ">=" "<=" ">" "<" "bool" "within"
}

// LadderSpec holds the status ladder's switches.
type LadderSpec struct {
	UnknownStatus         bool `json:"unknown_status"`           // v0 false (an unknown trigger reads as setup), v1 true
	PickRequiresStockPass bool `json:"pick_requires_stock_pass"` // true: a stock-specific rule must pass to be a pick
}

// ScoreSpec holds the score recipe's shares.
type ScoreSpec struct {
	PassFloor     float64 `json:"pass_floor"`
	PassStrength  float64 `json:"pass_strength"`
	TriggerCredit float64 `json:"trigger_credit"`
}

// DataReq is one data source the version needs and the earliest date it reads.
type DataReq struct {
	Source string `json:"source"`
	From   string `json:"from"`
}
