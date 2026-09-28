package shorts

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

// Stock picker handlers (StrategyService; docs/plans/stock-picker.md §3 and
// docs/plans/fundamentals-coverage.md §5.2).
//
// The universe (every candidate + the market regime) is read once per cache
// fill, prepared once (the financials decision and valuation,
// strategies.PrepareCandidates) and shared by all strategies; each strategy's
// FULL ranked pick list is evaluated once per fill and cached, then filtered,
// sorted and paged in memory. Cached values are read-only: filtering and
// sorting always work on copies. The inputs change once a day (after the
// evening price sweep), so 15 minutes is a freshness bound, not a performance
// compromise.
const (
	strategyCacheTTL          = 15 * time.Minute
	strategyPicksDefaultLimit = 20
	strategyPicksMaxLimit     = 100
)

// strategyUniverse is one cache fill of the evaluator's inputs. Read-only once
// cached.
type strategyUniverse struct {
	candidates []strategies.Candidate
	// index maps an upper-case stock code to its candidates position.
	index map[string]int
	// env is the evaluation environment (regime + the universe's rs_6m
	// quartile) every strategy and GetStockStrategyFit share.
	env             *strategies.Env
	regime          strategies.Regime
	coverage        int    // candidates with at least one growth figure
	qualityCoverage int    // candidates with a quality row
	rowsCount       int    // candidates with any fundamentals row
	asOf            string // newest price date, YYYY-MM-DD ("" when empty)
}

// coverageFor is the count a strategy's coverage caveat quotes.
func (u *strategyUniverse) coverageFor(st strategies.Strategy) int {
	if st.UsesQualityRules() {
		return u.qualityCoverage
	}
	return u.coverage
}

// strategyEvaluation is one strategy's full ranked pick list, cached.
type strategyEvaluation struct {
	picks []strategies.Pick
	// index maps an upper-case stock code to its picks position.
	index    map[string]int
	universe *strategyUniverse
}

// ListStrategies returns every strategy's definition and the market regime.
// The definitions are static, so a regime read failure degrades to an
// unknown regime rather than failing the whole call.
func (s *ShortsServer) ListStrategies(ctx context.Context, req *connect.Request[shortsv1alpha1.ListStrategiesRequest]) (*connect.Response[shortsv1alpha1.ListStrategiesResponse], error) {
	regime, err := s.loadMarketRegime(ctx)
	if err != nil {
		s.logger.Warnf("ListStrategies: market regime unavailable, serving it as unknown: %v", err)
		regime = strategies.Regime{IndexCode: strategies.DefaultIndexCode}
	}

	registry := strategies.Registry()
	resp := &shortsv1alpha1.ListStrategiesResponse{
		Strategies: make([]*shortsv1alpha1.Strategy, 0, len(registry)),
		Regime:     marketRegimeProto(regime, strategies.NeutralRegimeVerdict(regime)),
	}
	for _, st := range registry {
		resp.Strategies = append(resp.Strategies, strategyProto(st, st.CaveatsWithCoverage(0, -1)))
	}
	return connect.NewResponse(resp), nil
}

// GetStrategyPicks returns one strategy's ranked picks, filtered by status
// (and, on request, to stocks with a fundamentals row), optionally sorted by a
// fundamentals figure, and paged. Rank is always the evaluator's rank.
func (s *ShortsServer) GetStrategyPicks(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStrategyPicksRequest]) (*connect.Response[shortsv1alpha1.GetStrategyPicksResponse], error) {
	id := strings.ToLower(strings.TrimSpace(req.Msg.StrategyId))
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("strategy_id is required (one of %s)", strategyIDList()))
	}
	st, ok := strategies.Lookup(id)
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown strategy_id %q (one of %s)", req.Msg.StrategyId, strategyIDList()))
	}
	status := strings.ToLower(strings.TrimSpace(req.Msg.Status))
	if status != "" && !strategies.ValidPickStatus(status) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("status must be one of triggered, setup or watch"))
	}
	sortBy := strings.ToLower(strings.TrimSpace(req.Msg.SortBy))
	if sortBy != "" && !strategies.ValidSortBy(sortBy) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sort_by must be one of %s", strings.Join(strategies.SortKeys(), ", ")))
	}
	if req.Msg.Limit < 0 || req.Msg.Limit > strategyPicksMaxLimit {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and %d", strategyPicksMaxLimit))
	}
	if req.Msg.Offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset must not be negative"))
	}
	limit := int(req.Msg.Limit)
	if limit == 0 {
		limit = strategyPicksDefaultLimit
	}

	s.logger.Debugf("strategy picks: strategy_id=%s status=%s sort_by=%s require_fundamentals=%v limit=%d offset=%d",
		id, status, sortBy, req.Msg.RequireFundamentals, limit, req.Msg.Offset)

	eval, err := s.loadStrategyEvaluation(ctx, st)
	if err != nil {
		s.logger.Errorf("database error in GetStrategyPicks: strategy_id=%s err=%v", id, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to evaluate strategy"))
	}

	// Both steps leave the cached list untouched: the filter builds a new
	// slice, and SortPicks sorts a copy (or returns its input unchanged for
	// the default rank order, which is only ever read below).
	matching := strategies.SortPicks(filterPicks(eval.picks, status, req.Msg.RequireFundamentals), sortBy)
	total := len(matching)
	start := int(req.Msg.Offset)
	if start > total {
		start = total
	}
	end := start + limit
	if end > total {
		end = total
	}

	u := eval.universe
	resp := &shortsv1alpha1.GetStrategyPicksResponse{
		Strategy:                  strategyProto(st, st.CaveatsWithCoverage(u.coverageFor(st), len(u.candidates))),
		Regime:                    marketRegimeProto(u.regime, st.RegimeVerdict(u.regime)),
		Picks:                     make([]*shortsv1alpha1.StrategyPick, 0, end-start),
		TotalCount:                int32(total),
		UniverseCount:             int32(len(u.candidates)),
		FundamentalsCoverageCount: int32(u.coverage),
		FundamentalsRowsCount:     int32(u.rowsCount),
		AsOf:                      u.asOf,
	}
	for i := start; i < end; i++ {
		resp.Picks = append(resp.Picks, strategyPickProto(&matching[i]))
	}
	return connect.NewResponse(resp), nil
}

// filterPicks keeps the picks with the given status (all when "") and, when
// requireFundamentals, only stocks with a fundamentals row. With no filter it
// returns picks itself; otherwise a new slice, never a view that could alias
// the cache.
func filterPicks(picks []strategies.Pick, status string, requireFundamentals bool) []strategies.Pick {
	if status == "" && !requireFundamentals {
		return picks
	}
	out := make([]strategies.Pick, 0, len(picks))
	for i := range picks {
		p := &picks[i]
		if status != "" && string(p.Status) != status {
			continue
		}
		if requireFundamentals && !p.Candidate.HasFundamentalsRow() {
			continue
		}
		out = append(out, *p)
	}
	return out
}

// loadMarketRegime returns the XJO regime, cached for strategyCacheTTL.
func (s *ShortsServer) loadMarketRegime(ctx context.Context) (strategies.Regime, error) {
	// The fill outlives the request that triggered it (singleflight shares it
	// with concurrent callers), so it must not inherit that request's
	// cancellation. The store applies its own timeout.
	fillCtx := context.WithoutCancel(ctx)
	v, err := s.cache.GetOrSetWithTTL(s.cache.GetMarketRegimeKey(strategies.DefaultIndexCode), strategyCacheTTL, func() (interface{}, error) {
		return s.store.GetMarketRegime(fillCtx, strategies.DefaultIndexCode)
	})
	if err != nil {
		return strategies.Regime{}, err
	}
	return v.(strategies.Regime), nil
}

// loadStrategyUniverse returns every candidate plus the regime, prepared and
// indexed, cached for strategyCacheTTL and shared by all strategies.
func (s *ShortsServer) loadStrategyUniverse(ctx context.Context) (*strategyUniverse, error) {
	fillCtx := context.WithoutCancel(ctx)
	v, err := s.cache.GetOrSetWithTTL(s.cache.GetStrategyUniverseKey(), strategyCacheTTL, func() (interface{}, error) {
		cands, err := s.store.ListStrategyCandidates(fillCtx)
		if err != nil {
			return nil, err
		}
		regime, err := s.loadMarketRegime(fillCtx)
		if err != nil {
			return nil, err
		}
		// Once per fill, before any rule reads a candidate: the financials
		// decision (withholding not-meaningful ratios) and valuation.
		strategies.PrepareCandidates(cands)
		u := &strategyUniverse{
			candidates:      cands,
			index:           make(map[string]int, len(cands)),
			env:             strategies.NewEnv(cands, regime),
			regime:          regime,
			coverage:        strategies.FundamentalsCoverage(cands),
			qualityCoverage: strategies.QualityCoverage(cands),
			rowsCount:       strategies.FundamentalsRows(cands),
		}
		for i := range cands {
			u.index[strings.ToUpper(cands[i].StockCode)] = i
		}
		if latest := strategies.LatestAsOf(cands); !latest.IsZero() {
			u.asOf = latest.Format("2006-01-02")
		}
		return u, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*strategyUniverse), nil
}

// loadStrategyEvaluation returns one strategy's full ranked pick list,
// evaluated once per cache fill against the universe's shared environment.
func (s *ShortsServer) loadStrategyEvaluation(ctx context.Context, st strategies.Strategy) (*strategyEvaluation, error) {
	v, err := s.cache.GetOrSetWithTTL(s.cache.GetStrategyPicksKey(st.ID), strategyCacheTTL, func() (interface{}, error) {
		u, err := s.loadStrategyUniverse(ctx)
		if err != nil {
			return nil, err
		}
		picks := strategies.EvaluateWithEnv(st, u.candidates, u.env)
		index := make(map[string]int, len(picks))
		for i := range picks {
			index[strings.ToUpper(picks[i].Candidate.StockCode)] = i
		}
		return &strategyEvaluation{picks: picks, index: index, universe: u}, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*strategyEvaluation), nil
}

func strategyIDList() string {
	var ids []string
	for _, st := range strategies.Registry() {
		ids = append(ids, st.ID)
	}
	return strings.Join(ids, ", ")
}

func strategyProto(st strategies.Strategy, caveats []string) *shortsv1alpha1.Strategy {
	rules := make([]*shortsv1alpha1.StrategyRule, 0, len(st.Rules))
	for _, r := range st.Rules {
		rules = append(rules, &shortsv1alpha1.StrategyRule{
			Id:         r.ID,
			Title:      r.Title,
			RuleText:   r.RuleText,
			Evaluation: r.Evaluation,
			Core:       r.Core,
			DataSource: r.DataSource,
		})
	}
	return &shortsv1alpha1.Strategy{
		Id:                    st.ID,
		Name:                  st.Name,
		Author:                st.Author,
		Tagline:               st.Tagline,
		DescriptionParagraphs: append([]string(nil), st.Description...),
		Rules:                 rules,
		Metadata: &shortsv1alpha1.StrategyMetadata{
			Style:          st.Metadata.Style,
			HoldingPeriod:  st.Metadata.HoldingPeriod,
			RiskPosture:    st.Metadata.RiskPosture,
			Universe:       st.Metadata.Universe,
			RefreshCadence: st.Metadata.RefreshCadence,
			RuleCount:      int32(len(st.Rules)),
		},
		Caveats: append([]string(nil), caveats...),
		Sources: append([]string(nil), st.Sources...),
	}
}

func marketRegimeProto(r strategies.Regime, verdict string) *shortsv1alpha1.MarketRegime {
	out := &shortsv1alpha1.MarketRegime{
		IndexCode:      r.IndexCode,
		Regime:         r.Label,
		Close:          deref(r.Close),
		Sma50:          deref(r.SMA50),
		Sma200:         deref(r.SMA200),
		PctOff_52WHigh: deref(r.PctOff52wHigh),
		Verdict:        verdict,
	}
	if out.IndexCode == "" {
		out.IndexCode = strategies.DefaultIndexCode
	}
	if !r.Known() {
		out.Regime = ""
	}
	if r.AsOf != nil {
		out.AsOf = r.AsOf.Format("2006-01-02")
	}
	return out
}

func strategyPickProto(p *strategies.Pick) *shortsv1alpha1.StrategyPick {
	c := &p.Candidate
	marketCap := c.ResolvedMarketCap()
	out := &shortsv1alpha1.StrategyPick{
		Rank:            int32(p.Rank),
		StockCode:       c.StockCode,
		CompanyName:     c.CompanyName,
		Industry:        c.Industry,
		Status:          string(p.Status),
		Score:           p.Score,
		Rules:           ruleResultsProto(p.Rules),
		Close:           c.Close,
		PctOff_52WHigh:  deref(c.PctOff52wHigh),
		VolumeRatio_50D: deref(c.VolumeRatio50d),
		BaseDepthPct:    deref(c.BaseDepthPct),
		Pivot:           deref(c.BaseHigh),
		Rs_3MPct:        deref(c.RS3mPct),
		ShortPct:        deref(c.ShortPct),
		// The resolved market cap (plan fundamentals-coverage.md §5.3): our
		// own close x shares, the screener's figure only without shares.
		MarketCap: deref(marketCap),
		LogoUrl:   c.LogoURL,
		// Presence flags: a 0 in the doubles above is ambiguous without them.
		HasRs_3MPct:  c.RS3mPct != nil,
		HasShortPct:  c.ShortPct != nil,
		HasMarketCap: marketCap != nil,
		// Candidate.Close is not nullable: the store leaves it 0 for a NULL or
		// non-finite close, and mv_price_features only admits close > 0, so a
		// positive close is exactly "the stock has a valid last price".
		HasClose:     c.Close > 0,
		Fundamentals: pickFundamentalsProto(c),
	}
	if !c.AsOf.IsZero() {
		out.AsOf = c.AsOf.Format("2006-01-02")
	}
	if c.BaseLengthDays != nil {
		out.BaseLengthDays = *c.BaseLengthDays
	}
	if g := c.Growth; g != nil {
		if g.RevenueYoYPct != nil {
			out.RevenueYoyPct, out.HasRevenueYoy = *g.RevenueYoYPct, true
		}
		if g.EPSYoYPct != nil {
			out.EpsYoyPct, out.HasEpsYoy = *g.EPSYoYPct, true
		}
	}
	return out
}

func ruleResultsProto(results []strategies.RuleResult) []*shortsv1alpha1.RuleResult {
	out := make([]*shortsv1alpha1.RuleResult, 0, len(results))
	for _, r := range results {
		out = append(out, &shortsv1alpha1.RuleResult{
			RuleId:   r.RuleID,
			Status:   string(r.Status),
			Detail:   r.Detail,
			Value:    r.Value,
			HasValue: r.HasValue,
		})
	}
	return out
}

// pickFundamentalsProto is the fundamentals behind one pick's growth cells,
// with their basis, period and provenance, and headline ratios (plan
// fundamentals-coverage.md §5.2). nil when the stock has no fundamentals row.
// The candidate is prepared (financials decided, valuation computed), so a
// not-meaningful ratio is already absent here and named in not_meaningful.
func pickFundamentalsProto(c *strategies.Candidate) *shortsv1alpha1.PickFundamentals {
	if !c.HasFundamentalsRow() {
		return nil
	}
	out := &shortsv1alpha1.PickFundamentals{}
	var fetched *time.Time
	if g := c.Growth; g != nil {
		out.Currency = g.Currency
		fetched = g.FetchedAt
		if g.NetIncomePositive != nil {
			out.NetIncomePositive = *g.NetIncomePositive
		}
		if g.RevenueYoYPct != nil {
			out.RevenueBasisPeriodType = revenueBasisPeriodType(g)
			out.RevenuePeriodEnd = dateString(revenuePeriodEnd(g))
			out.RevenueBasisSource = g.RevenueBasisSource
		}
		if g.EPSYoYPct != nil {
			out.EpsBasisPeriodType = g.BasisPeriodType
			out.EpsPeriodEnd = dateString(g.LatestPeriodEnd)
			out.EpsBasisSource = g.EPSBasisSource
		}
	}
	if q := c.Quality; q != nil {
		if out.Currency == "" {
			out.Currency = q.Currency
		}
		if q.FetchedAt != nil && (fetched == nil || q.FetchedAt.After(*fetched)) {
			fetched = q.FetchedAt
		}
		out.NetMarginPct, out.HasNetMarginPct = optional(q.NetMarginPct)
		out.RoePct, out.HasRoePct = optional(q.ROEPct)
		out.FcfMarginPct, out.HasFcfMarginPct = optional(q.FCFMarginPct)
		out.NetDebtToEbitda, out.HasNetDebtToEbitda = optional(q.NetDebtToEBITDA)
	}
	out.PeRatio, out.HasPeRatio = optional(c.Valuation.PERatio)
	out.IsFinancial, _, out.NotMeaningful = strategies.FinancialFlags(c.Quality, c.Industry)
	if fetched != nil {
		out.FetchedAt = fetched.UTC().Format(time.RFC3339)
	}
	return out
}

// revenueBasisPeriodType is the series revenue growth used; a growth row from
// before the half basis existed carries no type and was always annual.
func revenueBasisPeriodType(g *strategies.Growth) string {
	if g.RevenueBasisPeriodType == "" {
		return "annual"
	}
	return g.RevenueBasisPeriodType
}

// revenuePeriodEnd is the end of the latest period in the revenue pair: the
// view's own column when 000132 supplies it, else the date the basis implies.
func revenuePeriodEnd(g *strategies.Growth) *time.Time {
	if g.RevenueLatestPeriodEnd != nil {
		return g.RevenueLatestPeriodEnd
	}
	switch revenueBasisPeriodType(g) {
	case "half":
		return g.HalfLatestPeriodEnd
	case "annual":
		return g.LatestAnnualPeriodEnd
	}
	return nil
}

// deref reads a nullable float, 0 when nil (proto3 has no null double; the
// has_* flags carry absence where it matters).
func deref(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}
