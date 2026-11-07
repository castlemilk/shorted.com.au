package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"connectrpc.com/connect"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The backtest resource (8.7, OD-21): one resource template, no tool. A client reads
// shorted://strategies/{id}/backtest and gets the strategy's published canonical backtest. The text opens
// with the recipe preface, so no reader can take the figures for the author's own entries and exits; the
// JSON carries the integrity fields a figure must be read with. A strategy whose run is not published
// says so in its state, and carries none of the figures.

// backtestTemplateURI is the resource template's URI.
const backtestTemplateURI = "shorted://strategies/{id}/backtest"

const (
	backtestURIPrefix = "shorted://strategies/"
	backtestURISuffix = "/backtest"
)

// backtestResourceRPCs are the rpcs the resource reads. A resource is not a tool, so the DataSource
// invariant (every method is reached by a tool) counts these as declared.
var backtestResourceRPCs = []string{"shorts.v1alpha1.StrategyService.GetBacktestRun"}

// strategyResourceID is a canonical strategy id as the URI carries it: lower case letters, digits and
// hyphens. A variant reference is not a strategy id and never matches.
var strategyResourceID = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// backtestBody is the JSON the resource carries after the preface. The keys of 8.7 are present whenever
// the run is computed: rules_version, engine_version, run_date, window, in_sample_until, returns,
// benchmark, costs, survivorship, coverage_by_year, approximate and fundamentals_label.
type backtestBody struct {
	StrategyID        string            `json:"strategy_id"`
	State             string            `json:"state"`
	StateReason       string            `json:"state_reason,omitempty"`
	RulesVersion      string            `json:"rules_version,omitempty"`
	EngineVersion     string            `json:"engine_version,omitempty"`
	RunDate           string            `json:"run_date,omitempty"`
	Window            string            `json:"window,omitempty"`
	InSampleUntil     string            `json:"in_sample_until,omitempty"`
	Returns           string            `json:"returns,omitempty"`
	Benchmark         string            `json:"benchmark,omitempty"`
	ReferenceName     string            `json:"reference_name,omitempty"`
	Costs             []string          `json:"costs,omitempty"`
	RecipeEntry       string            `json:"recipe_entry,omitempty"`
	Survivorship      *backtestSurv     `json:"survivorship,omitempty"`
	CoverageByYear    []backtestCovYear `json:"coverage_by_year,omitempty"`
	Approximate       bool              `json:"approximate"`
	FundamentalsLabel string            `json:"fundamentals_label,omitempty"`
	Windows           []backtestWindow  `json:"windows,omitempty"`
	Sensitivity       []backtestSens    `json:"sensitivity,omitempty"`
	ReplayAgreement   string            `json:"replay_agreement,omitempty"`
	InputChangeNote   string            `json:"input_change_note,omitempty"`
	Disclosures       []string          `json:"disclosures,omitempty"`
	ComputableFrom    string            `json:"computable_from,omitempty"`
	FiscalLabel       string            `json:"fiscal_label,omitempty"`
	RunningSince      string            `json:"running_since,omitempty"`
}

type backtestSurv struct {
	Measurement string `json:"measurement"`
	Direction   string `json:"direction"`
	Statement   string `json:"statement"`
	Caveat      string `json:"caveat,omitempty"`
}

type backtestCovYear struct {
	Year           int32    `json:"year"`
	QualifyingPct  *float64 `json:"qualifying_pct,omitempty"`
	AllReportedPct *float64 `json:"all_reported_pct,omitempty"`
}

type backtestWindow struct {
	Window                        string   `json:"window"`
	Label                         string   `json:"label"`
	From                          string   `json:"from"`
	To                            string   `json:"to"`
	TotalReturnPct                *float64 `json:"total_return_pct,omitempty"`
	CagrPct                       *float64 `json:"cagr_pct,omitempty"`
	NotAnnualised                 bool     `json:"not_annualised"`
	BenchmarkCagrPct              *float64 `json:"benchmark_cagr_pct,omitempty"`
	ReferenceCagrPct              *float64 `json:"reference_cagr_pct,omitempty"`
	BenchmarkTotalReturnPct       *float64 `json:"benchmark_total_return_pct,omitempty"`
	ReferenceTotalReturnPct       *float64 `json:"reference_total_return_pct,omitempty"`
	ReferenceTo                   string   `json:"reference_to,omitempty"`
	StrategyOverlapTotalReturnPct *float64 `json:"strategy_overlap_total_return_pct,omitempty"`
	MaxDrawdownPct                float64  `json:"max_drawdown_pct"`
	Sharpe                        *float64 `json:"sharpe,omitempty"`
	SharpeSE                      *float64 `json:"sharpe_se,omitempty"`
	ClosedTrades                  int32    `json:"closed_trades"`
	WinRatePct                    *float64 `json:"win_rate_pct,omitempty"`
	Note                          string   `json:"note,omitempty"`
}

type backtestSens struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	CagrPct     *float64 `json:"cagr_pct,omitempty"`
	ExcessPct   *float64 `json:"excess_vs_benchmark_pct,omitempty"`
	Fragile     bool     `json:"fragile"`
	FragileChip string   `json:"fragile_chip,omitempty"`
	Applies     bool     `json:"applies"`
	Reason      string   `json:"reason,omitempty"`
}

// backtestResourceText is the resource's text: the recipe preface, a blank line, then the JSON body.
func backtestResourceText(run *shortsv1alpha1.BacktestRun) (string, error) {
	body := backtestBody{StrategyID: run.GetStrategyId(), State: run.GetState(), StateReason: run.GetStateReason()}
	switch run.GetState() {
	case "not_computable":
		body.ComputableFrom, body.FiscalLabel = run.GetComputableFrom(), run.GetFiscalLabel()
	case "running":
		body.RunningSince = run.GetRunningSince()
	case "published", "approximate":
		fillComputed(&body, run)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	return spec.RecipePreface + "\n\n" + string(raw), nil
}

// fillComputed copies a computed run's figures and integrity fields into the body.
func fillComputed(body *backtestBody, run *shortsv1alpha1.BacktestRun) {
	id := run.GetIdentity()
	if v := id.GetVersion(); v != nil {
		hash := v.GetRulesHash()
		if len(hash) > 8 {
			hash = hash[:8]
		}
		body.RulesVersion = fmt.Sprintf("%s %s · engine %s", v.GetLabel(), hash, id.GetEngineVersion())
	}
	body.EngineVersion = id.GetEngineVersion()
	body.RunDate = id.GetRunDate()
	body.Window = run.GetWindowId()
	body.InSampleUntil = id.GetInSampleUntil()
	body.Returns = id.GetReturns()
	body.Benchmark = id.GetBenchmark()
	body.ReferenceName = id.GetReferenceName()
	body.Approximate = run.GetState() == "approximate"
	body.FundamentalsLabel = run.GetFundamentalsLabel()
	if r := run.GetRecipe(); r != nil {
		body.Costs = []string{r.GetBrokerage(), r.GetSpread()}
		body.RecipeEntry = r.GetEntry()
	}
	if s := run.GetSurvivorship(); s != nil {
		body.Survivorship = &backtestSurv{Measurement: s.GetMeasurement(), Direction: s.GetDirection(), Statement: s.GetStatement(), Caveat: s.GetCaveat()}
	}
	for _, c := range run.GetCoverage() {
		row := backtestCovYear{Year: c.GetYear()}
		if c.GetMeasurable() {
			row.QualifyingPct = ptr(c.GetCoveragePct())
		}
		if c.GetAllReportedMeasurable() {
			row.AllReportedPct = ptr(c.GetAllReportedPct())
		}
		body.CoverageByYear = append(body.CoverageByYear, row)
	}
	for _, w := range run.GetWindows() {
		row := backtestWindow{
			Window: w.GetWindow(), Label: w.GetLabel(), From: w.GetFrom(), To: w.GetTo(),
			MaxDrawdownPct: w.GetMaxDrawdownPct(), NotAnnualised: w.GetNotAnnualised(),
			ClosedTrades: w.GetClosedTrades(), Note: w.GetNote(),
		}
		if w.GetHasTotalReturn() {
			row.TotalReturnPct = ptr(w.GetTotalReturnPct())
		}
		if w.GetHasCagr() {
			row.CagrPct = ptr(w.GetCagrPct())
		}
		if w.GetHasBenchmark() {
			row.BenchmarkCagrPct = ptr(w.GetBenchmarkCagrPct())
		}
		if w.GetHasReference() {
			row.ReferenceCagrPct = ptr(w.GetReferenceCagrPct())
		}
		if w.GetHasBenchmarkTotalReturn() {
			row.BenchmarkTotalReturnPct = ptr(w.GetBenchmarkTotalReturnPct())
		}
		// The reference is measured over the overlap that ends at reference_to; the strategy's figure over the
		// same sessions is served beside it, so a comparison is like for like.
		if w.GetHasReferenceTotalReturn() {
			row.ReferenceTotalReturnPct = ptr(w.GetReferenceTotalReturnPct())
			row.ReferenceTo = w.GetReferenceTo()
		}
		if w.GetHasStrategyOverlapTotalReturn() {
			row.StrategyOverlapTotalReturnPct = ptr(w.GetStrategyOverlapTotalReturnPct())
		}
		if w.GetHasSharpe() {
			row.Sharpe = ptr(w.GetSharpe())
			row.SharpeSE = ptr(w.GetSharpeSe())
		}
		if w.GetHasWinRate() {
			row.WinRatePct = ptr(w.GetWinRatePct())
		}
		body.Windows = append(body.Windows, row)
	}
	for _, sn := range run.GetSensitivity() {
		row := backtestSens{ID: sn.GetId(), Label: sn.GetLabel(), Fragile: sn.GetFragile(), FragileChip: sn.GetFragileChip(), Applies: sn.GetApplies(), Reason: sn.GetReason()}
		if sn.GetHasCagr() {
			row.CagrPct = ptr(sn.GetCagrPct())
		}
		if sn.GetHasExcess() {
			row.ExcessPct = ptr(sn.GetExcessVsBenchmarkPct())
		}
		body.Sensitivity = append(body.Sensitivity, row)
	}
	body.ReplayAgreement = run.GetReplayAgreement()
	body.InputChangeNote = run.GetInputChangeNote()
	body.Disclosures = run.GetDisclosures()
}

func ptr(v float64) *float64 { return &v }

// registerBacktestResources wires the backtest resource template onto the server.
func registerBacktestResources(server *sdk.Server, src DataSource) {
	server.AddResourceTemplate(&sdk.ResourceTemplate{
		URITemplate: backtestTemplateURI,
		Name:        "Strategy backtest",
		Title:       "Strategy backtest",
		Description: "A stock-picking strategy's published backtest: the recipe preface, the chained windows, annual returns, coverage by year, the survivorship statement and the run's identity. Hypothetical results, not a record of trading.",
		MIMEType:    "text/plain",
	}, backtestHandler(src))
}

// backtestHandler reads one strategy's live backtest from the data source. The data source caches the
// answer per instance, so the resource and the rpc share one cache.
func backtestHandler(src DataSource) sdk.ResourceHandler {
	return func(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		if req == nil || req.Params == nil {
			return nil, fmt.Errorf("invalid strategy backtest URI")
		}
		uri := req.Params.URI
		if !strings.HasPrefix(uri, backtestURIPrefix) || !strings.HasSuffix(uri, backtestURISuffix) {
			return nil, fmt.Errorf("invalid strategy backtest URI")
		}
		id := strings.TrimSuffix(strings.TrimPrefix(uri, backtestURIPrefix), backtestURISuffix)
		if !strategyResourceID.MatchString(id) {
			return nil, fmt.Errorf("invalid strategy backtest URI")
		}
		resp, err := src.GetBacktestRun(ctx, connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: id}))
		if err != nil {
			return nil, err
		}
		text, err := backtestResourceText(resp.Msg.GetRun())
		if err != nil {
			return nil, err
		}
		return &sdk.ReadResourceResult{
			CacheScope: "public",
			Contents:   []*sdk.ResourceContents{{URI: uri, MIMEType: "text/plain", Text: text}},
		}, nil
	}
}
