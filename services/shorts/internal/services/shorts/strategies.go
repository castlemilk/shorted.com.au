package shorts

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// Stock picker handlers (StrategyService; docs/plans/stock-picker.md §3 and
// docs/plans/fundamentals-coverage.md §5.2).
//
// The universe (every candidate + the market regime) is read once per cache
// fill, prepared once (the financials decision and valuation,
// engine.PrepareCandidates) and shared by all strategies; each strategy's
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
	candidates []engine.Candidate
	// index maps an upper-case stock code to its candidates position.
	index map[string]int
	// env is the evaluation environment (regime + the universe's rs_6m
	// quartile) every strategy and GetStockStrategyFit share.
	env             *engine.Env
	regime          engine.Regime
	coverage        int    // candidates with at least one growth figure
	qualityCoverage int    // candidates with a quality row
	rowsCount       int    // candidates with any fundamentals row
	asOf            string // newest price date, YYYY-MM-DD ("" when empty)
	// shortReportDate is the newest short report date across the universe
	// (zero when no stock has one).
	shortReportDate time.Time
	// shortAvailable is the stored publication date of the newest report's
	// candidates (nil on the views path, or when none is stored).
	shortAvailable *time.Time
	// source names what answered the universe: "views" or "snapshot".
	source string
	// served is the version each strategy is served under, resolved once per
	// fill from the source and the table's live rows (resolveServed).
	served map[string]servedVersion
	// ineligible is why a stock the snapshot stores is outside the universe
	// (no bar on the session, an ETP, a corporate-action guard), keyed by code.
	// Empty on the views path, where a stock outside the universe has short history.
	ineligible map[string]string
}

// coverageFor is the count a strategy's coverage caveat quotes.
func (u *strategyUniverse) coverageFor(st engine.Strategy) int {
	if st.UsesQualityRules() {
		return u.qualityCoverage
	}
	return u.coverage
}

// strategyEvaluation is one strategy's full ranked pick list, cached.
type strategyEvaluation struct {
	picks []engine.Pick
	// index maps an upper-case stock code to its picks position.
	index    map[string]int
	universe *strategyUniverse
	// version is the rules version the picks were evaluated under.
	version *shortsv1alpha1.StrategyVersionRef
	// candidates is how many stocks the strategy's own universe holds (the
	// ASIC-reported names for Crowded-Short), and env its rs statistics.
	candidates int
	env        *engine.Env
}

// ListStrategies returns every strategy's definition and the market regime.
// The definitions are static, so a regime read failure degrades to an
// unknown regime rather than failing the whole call.
func (s *ShortsServer) ListStrategies(ctx context.Context, req *connect.Request[shortsv1alpha1.ListStrategiesRequest]) (*connect.Response[shortsv1alpha1.ListStrategiesResponse], error) {
	regime, err := s.listStrategiesRegime(ctx)
	if err != nil {
		s.logger.Warnf("ListStrategies: market regime unavailable, serving it as unknown: %v", err)
		regime = engine.Regime{IndexCode: engine.DefaultIndexCode}
	}

	registry := engine.Registry()
	resp := &shortsv1alpha1.ListStrategiesResponse{
		Strategies: make([]*shortsv1alpha1.Strategy, 0, len(registry)),
		Regime:     marketRegimeProto(regime, engine.NeutralRegimeVerdict(regime)),
	}
	for _, st := range registry {
		resp.Strategies = append(resp.Strategies, strategyProto(st, st.CaveatsWithCoverage(0, -1), s.servedRef(ctx, st.ID)))
	}
	return connect.NewResponse(resp), nil
}

// picksQuery is a validated GetStrategyPicks request. The public and the
// private rpc share it, so the same request is refused the same way for every
// caller.
type picksQuery struct {
	st                  engine.Strategy
	status              string
	sortBy              string
	requireFundamentals bool
	limit               int
	offset              int
}

// picksDepth is how much of a ranked list one caller receives.
type picksDepth struct {
	access Access
	// limit is how many top rows of the default ranking the caller may page.
	// 0 is unlimited.
	limit int
}

// parsePicksQuery validates a GetStrategyPicks request. It reads no depth, so
// a refusal here is the same for every caller.
func parsePicksQuery(msg *shortsv1alpha1.GetStrategyPicksRequest) (picksQuery, error) {
	id := strings.ToLower(strings.TrimSpace(msg.StrategyId))
	if id == "" {
		return picksQuery{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("strategy_id is required (one of %s)", strategyIDList()))
	}
	st, ok := engine.Lookup(id)
	if !ok {
		return picksQuery{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown strategy_id %q (one of %s)", msg.StrategyId, strategyIDList()))
	}
	status := strings.ToLower(strings.TrimSpace(msg.Status))
	if status != "" && !engine.ValidPickStatus(status) {
		return picksQuery{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("status must be one of triggered, setup, unknown or watch"))
	}
	sortBy := strings.ToLower(strings.TrimSpace(msg.SortBy))
	if sortBy != "" && !engine.ValidSortBy(sortBy) {
		return picksQuery{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sort_by must be one of %s", strings.Join(engine.SortKeys(), ", ")))
	}
	if msg.Limit < 0 || msg.Limit > strategyPicksMaxLimit {
		return picksQuery{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and %d", strategyPicksMaxLimit))
	}
	if msg.Offset < 0 {
		return picksQuery{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset must not be negative"))
	}
	limit := int(msg.Limit)
	if limit == 0 {
		limit = strategyPicksDefaultLimit
	}
	return picksQuery{
		st:                  st,
		status:              status,
		sortBy:              sortBy,
		requireFundamentals: msg.RequireFundamentals,
		limit:               limit,
		offset:              int(msg.Offset),
	}, nil
}

// GetStrategyPicks returns one strategy's ranked picks, filtered by status
// (and, on request, to stocks with a fundamentals row), optionally sorted by a
// fundamentals figure, and paged. Rank is always the evaluator's rank.
//
// The answer is the same bytes to every HTTP caller, API tokens included.
// When the public depth limit is set, only the top of the default ranking is
// served, and any offset other than 0 is refused. Depth is read after the
// cached evaluation, never inside its fill.
func (s *ShortsServer) GetStrategyPicks(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStrategyPicksRequest]) (*connect.Response[shortsv1alpha1.GetStrategyPicksResponse], error) {
	q, err := parsePicksQuery(req.Msg)
	if err != nil {
		return nil, err
	}
	s.logger.Debugf("strategy picks: strategy_id=%s status=%s sort_by=%s require_fundamentals=%v limit=%d offset=%d",
		q.st.ID, q.status, q.sortBy, q.requireFundamentals, q.limit, q.offset)

	eval, err := s.loadStrategyEvaluation(ctx, q.st)
	if err != nil {
		s.logger.Errorf("database error in GetStrategyPicks: strategy_id=%s err=%v", q.st.ID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to evaluate strategy"))
	}

	depth := s.publicPicksDepth(ctx)
	if depth.limit > 0 && q.offset != 0 {
		return nil, fullSignalListRefused(depth.access, depth.limit)
	}
	return connect.NewResponse(picksResponse(eval, q, depth)), nil
}

// GetViewerStrategyPicks is GetStrategyPicks at the caller's full depth. It
// needs a verified identity and is never clamped.
func (s *ShortsServer) GetViewerStrategyPicks(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStrategyPicksRequest]) (*connect.Response[shortsv1alpha1.GetStrategyPicksResponse], error) {
	access, _, err := privateAccess(ctx)
	if err != nil {
		return nil, err
	}
	q, err := parsePicksQuery(req.Msg)
	if err != nil {
		return nil, err
	}
	s.logger.Debugf("viewer strategy picks: strategy_id=%s access=%s status=%s sort_by=%s require_fundamentals=%v limit=%d offset=%d",
		q.st.ID, access, q.status, q.sortBy, q.requireFundamentals, q.limit, q.offset)

	eval, err := s.loadStrategyEvaluation(ctx, q.st)
	if err != nil {
		s.logger.Errorf("database error in GetViewerStrategyPicks: strategy_id=%s err=%v", q.st.ID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to evaluate strategy"))
	}
	return connect.NewResponse(picksResponse(eval, q, picksDepth{access: access})), nil
}

// publicPicksDepth is the depth a public read gives its caller. An anonymous
// caller gets the clamp when the flag is set; a verified MCP viewer does not.
func (s *ShortsServer) publicPicksDepth(ctx context.Context) picksDepth {
	access := publicDepth(ctx)
	if access != AccessAnonymous {
		return picksDepth{access: access}
	}
	return picksDepth{access: access, limit: s.config.StrategyPublicSignalsLimit}
}

// picksResponse builds one caller's answer from the cached evaluation. The
// cached list is read-only: the clamp, the filter and the sort all work on
// slices of it, never on the list itself.
//
// Under a clamp the rows come from the top of the default ranking only, and
// the filter and sort apply within them. The counts and the total stay global,
// since they reveal no names.
func picksResponse(eval *strategyEvaluation, q picksQuery, depth picksDepth) *shortsv1alpha1.GetStrategyPicksResponse {
	u := eval.universe
	ranked := eval.picks
	limit := q.limit
	if depth.limit > 0 {
		if len(ranked) > depth.limit {
			ranked = ranked[:depth.limit]
		}
		limit = min(limit, depth.limit)
	}

	// Both steps leave the cached list untouched: the filter builds a new
	// slice, and SortPicks sorts a copy (or returns its input unchanged for
	// the default rank order, which is only ever read below).
	matching := engine.SortPicks(filterPicks(ranked, q.status, q.requireFundamentals), q.sortBy)
	total := len(matching)
	// clamped says a row that matches this query exists beyond the depth, so
	// a filter that the top of the list fully answers reads false.
	clamped := false
	if depth.limit > 0 {
		total = len(filterPicks(eval.picks, q.status, q.requireFundamentals))
		clamped = total > len(matching)
	}
	start := min(q.offset, len(matching))
	end := min(start+limit, len(matching))

	resp := &shortsv1alpha1.GetStrategyPicksResponse{
		Strategy:                  strategyProto(q.st, q.st.CaveatsWithCoverage(u.coverageFor(q.st), eval.candidates), eval.version),
		Regime:                    marketRegimeProto(u.regime, q.st.RegimeVerdict(u.regime)),
		Picks:                     make([]*shortsv1alpha1.StrategyPick, 0, end-start),
		TotalCount:                int32(total),
		UniverseCount:             int32(eval.candidates),
		FundamentalsCoverageCount: int32(u.coverage),
		FundamentalsRowsCount:     int32(u.rowsCount),
		AsOf:                      u.asOf,
		StatusCounts:              statusCounts(eval.picks),
		SessionDate:               u.asOf,
		ShortReportDate:           dateOrEmpty(u.shortReportDate),
		UniverseLabel:             q.st.Metadata.Universe,
		Stale:                     staleBehind(u.asOf, u.regime),
		Viewer: &shortsv1alpha1.ViewerDepth{
			Access:         depth.access.String(),
			Clamped:        clamped,
			RequiredAccess: AccessFree.String(),
			Limit:          int32(depth.limit),
		},
		Version: eval.version,
	}
	if thr, ok := eval.env.RSQuantileThreshold(); ok {
		resp.RsQuantileThreshold, resp.HasRsQuantileThreshold = thr, true
	}
	if !u.shortReportDate.IsZero() {
		_, resp.ShortAvailableDate = shortDatesProto(&u.shortReportDate, u.shortAvailable)
	}
	for i := start; i < end; i++ {
		resp.Picks = append(resp.Picks, strategyPickProto(&matching[i]))
	}
	return resp
}

// filterPicks keeps the picks with the given status (all when "") and, when
// requireFundamentals, only stocks with a fundamentals row. With no filter it
// returns picks itself; otherwise a new slice, never a view that could alias
// the cache.
func filterPicks(picks []engine.Pick, status string, requireFundamentals bool) []engine.Pick {
	if status == "" && !requireFundamentals {
		return picks
	}
	out := make([]engine.Pick, 0, len(picks))
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

// listStrategiesRegime is the regime the hub's banner reads. Under the snapshot
// source it is the regime the picks were evaluated against (the universe's), so
// the banner and the cards name the same session; a failed universe read falls
// back to the views' regime.
func (s *ShortsServer) listStrategiesRegime(ctx context.Context) (engine.Regime, error) {
	if s.config.StrategySource == StrategySourceSnapshot {
		u, err := s.loadStrategyUniverse(ctx)
		if err == nil {
			return u.regime, nil
		}
		s.logger.Warnf("ListStrategies: snapshot universe unavailable, reading the views' regime: %v", err)
	}
	return s.loadMarketRegime(ctx)
}

// loadMarketRegime returns the XJO regime, cached for strategyCacheTTL.
func (s *ShortsServer) loadMarketRegime(ctx context.Context) (engine.Regime, error) {
	// The fill outlives the request that triggered it (singleflight shares it
	// with concurrent callers), so it must not inherit that request's
	// cancellation. The store applies its own timeout.
	fillCtx := context.WithoutCancel(ctx)
	v, err := s.cache.GetOrSetWithTTL(s.cache.GetMarketRegimeKey(engine.DefaultIndexCode), strategyCacheTTL, func() (any, error) {
		return s.store.GetMarketRegime(fillCtx, engine.DefaultIndexCode)
	})
	if err != nil {
		return engine.Regime{}, err
	}
	return v.(engine.Regime), nil
}

// loadStrategyUniverse returns every candidate plus the regime, prepared and
// indexed, cached for strategyCacheTTL and shared by all strategies. The source
// is the daily snapshot when STRATEGY_SOURCE says so and it has a completed
// session, else the views.
func (s *ShortsServer) loadStrategyUniverse(ctx context.Context) (*strategyUniverse, error) {
	fillCtx := context.WithoutCancel(ctx)
	v, err := s.cache.GetOrSetWithTTL(s.cache.GetStrategyUniverseKey(), strategyCacheTTL, func() (any, error) {
		u, ok, err := s.snapshotUniverse(fillCtx)
		if err != nil {
			return nil, err
		}
		if ok {
			return u, nil
		}
		cands, err := s.store.ListStrategyCandidates(fillCtx)
		if err != nil {
			return nil, err
		}
		regime, err := s.loadMarketRegime(fillCtx)
		if err != nil {
			return nil, err
		}
		asOf := ""
		if latest := engine.LatestAsOf(cands); !latest.IsZero() {
			asOf = latest.Format("2006-01-02")
		}
		return newStrategyUniverse(cands, regime, asOf, StrategySourceViews, nil), nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*strategyUniverse), nil
}

// newStrategyUniverse prepares the candidates (the financials decision and
// valuation, once per fill, before any rule reads a candidate) and indexes them
// with the universe's shared environment. asOf is the session the universe is
// as at, "" when unknown.
func newStrategyUniverse(cands []engine.Candidate, regime engine.Regime, asOf, source string, live map[string]shortsstore.LiveRuleVersion) *strategyUniverse {
	engine.PrepareCandidates(cands)
	u := &strategyUniverse{
		candidates:      cands,
		index:           make(map[string]int, len(cands)),
		env:             engine.NewEnvFromStats(regime, engine.UniverseStatsOf(cands)),
		regime:          regime,
		coverage:        engine.FundamentalsCoverage(cands),
		qualityCoverage: engine.QualityCoverage(cands),
		rowsCount:       engine.FundamentalsRows(cands),
		asOf:            asOf,
		source:          source,
		served:          resolveServed(source, live),
	}
	for i := range cands {
		u.index[strings.ToUpper(cands[i].StockCode)] = i
		if d := cands[i].ShortReportDate; d != nil && d.After(u.shortReportDate) {
			u.shortReportDate = *d
			u.shortAvailable = cands[i].ShortAvailableDate
		}
	}
	return u
}

// strategyCandidates is the candidates a strategy's version ranks. The shared
// universe is the ordinary, fresh stocks; a version whose universe names the
// ASIC report (Crowded-Short, v1) ranks only the stocks the report lists, and
// its rs statistics are over that universe.
func (s *ShortsServer) strategyCandidates(strategyID string, u *strategyUniverse) ([]engine.Candidate, *engine.Env) {
	reg := u.served[strategyID].reg
	if !reg.Spec.Universe.ASICReported {
		return u.candidates, u.env
	}
	reported := make([]engine.Candidate, 0, len(u.candidates))
	for i := range u.candidates {
		if u.candidates[i].InASICReport {
			reported = append(reported, u.candidates[i])
		}
	}
	return reported, engine.NewEnvFromStats(u.regime, engine.UniverseStatsOf(reported))
}

// loadStrategyEvaluation returns one strategy's full ranked pick list,
// evaluated once per cache fill against the universe's shared environment.
func (s *ShortsServer) loadStrategyEvaluation(ctx context.Context, st engine.Strategy) (*strategyEvaluation, error) {
	v, err := s.cache.GetOrSetWithTTL(s.cache.GetStrategyPicksKey(st.ID), strategyCacheTTL, func() (any, error) {
		u, err := s.loadStrategyUniverse(ctx)
		if err != nil {
			return nil, err
		}
		sv := u.served[st.ID]
		st.UnknownStatus = sv.reg.Spec.Ladder.UnknownStatus
		cands, env := s.strategyCandidates(st.ID, u)
		picks := engine.EvaluateWithEnv(st, cands, env)
		index := make(map[string]int, len(picks))
		for i := range picks {
			index[strings.ToUpper(picks[i].Candidate.StockCode)] = i
		}
		return &strategyEvaluation{
			picks:      picks,
			index:      index,
			universe:   u,
			version:    servedRefOf(sv),
			candidates: len(cands),
			env:        env,
		}, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*strategyEvaluation), nil
}

// statusCounts counts a ranked list by status: the whole list the caller
// filters and pages, never the filtered page.
func statusCounts(picks []engine.Pick) *shortsv1alpha1.StatusCounts {
	out := &shortsv1alpha1.StatusCounts{}
	for i := range picks {
		switch picks[i].Status {
		case engine.StatusTriggered:
			out.Triggered++
		case engine.StatusSetup:
			out.Setup++
		case engine.StatusUnknown:
			out.Unknown++
		case engine.StatusWatch:
			out.Watch++
		}
	}
	return out
}

// dateOrEmpty is a YYYY-MM-DD day, or "" for the zero time (absent).
func dateOrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02")
}

// shortDatesProto returns a short position's report date and the date it
// became public. Both are empty when the stock has no report. The publication
// date is the stored one when the snapshot holds it (stored non-nil), so the
// page shows the date the reading was gated on; otherwise the ASX calendar's.
// Neither names a date for a report the holiday table does not cover, so the
// snapshot answers as the views do.
func shortDatesProto(report, stored *time.Time) (reported, available string) {
	if report == nil {
		return "", ""
	}
	if _, covered := asxcalendar.AvailableFromCovered(*report); !covered {
		return dateOrEmpty(*report), ""
	}
	if stored != nil {
		return dateOrEmpty(*report), dateOrEmpty(*stored)
	}
	published, _ := asxcalendar.AvailableFromCovered(*report)
	return dateOrEmpty(*report), dateOrEmpty(published)
}

// staleBehind reports whether the market index has closed a session the
// prices have not reached yet (the "data delayed" state): the picks or the
// readings are then older than the market they are read against. The index's
// own newest session counts, so a refresh that never ran is still reported;
// the regime's date alone would agree with the prices, since both views move
// together.
func staleBehind(asOf string, regime engine.Regime) bool {
	if asOf == "" {
		return false
	}
	for _, day := range []*time.Time{regime.AsOf, regime.LatestSession} {
		if day != nil && day.Format("2006-01-02") > asOf {
			return true
		}
	}
	return false
}

func strategyIDList() string {
	var ids []string
	for _, st := range engine.Registry() {
		ids = append(ids, st.ID)
	}
	return strings.Join(ids, ", ")
}

func strategyProto(st engine.Strategy, caveats []string, version *shortsv1alpha1.StrategyVersionRef) *shortsv1alpha1.Strategy {
	rules := make([]*shortsv1alpha1.StrategyRule, 0, len(st.Rules))
	for _, r := range st.Rules {
		rules = append(rules, &shortsv1alpha1.StrategyRule{
			Id:           r.ID,
			Title:        r.Title,
			RuleText:     r.RuleText,
			Evaluation:   r.Evaluation,
			Core:         r.Core,
			DataSource:   r.DataSource,
			Trigger:      r.Trigger,
			Weight:       r.Weight,
			Threshold:    r.Threshold,
			HasThreshold: r.HasThreshold,
			Unit:         r.Unit,
			Comparator:   r.Comparator,
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
		Version: version,
	}
}

func marketRegimeProto(r engine.Regime, verdict string) *shortsv1alpha1.MarketRegime {
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
		out.IndexCode = engine.DefaultIndexCode
	}
	if !r.Known() {
		out.Regime = ""
	}
	if r.AsOf != nil {
		out.AsOf = r.AsOf.Format("2006-01-02")
	}
	return out
}

func strategyPickProto(p *engine.Pick) *shortsv1alpha1.StrategyPick {
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
	out.HasPctOff_52WHigh = c.PctOff52wHigh != nil
	out.DaysToCover, out.HasDaysToCover = optional(c.DaysToCover)
	out.Rs_6MPct, out.HasRs_6MPct = optional(c.RS6mPct)
	out.Rs_6MPercentile, out.HasRs_6MPercentile = optional(p.RS6mPercentile)
	out.DollarVolume_20D, out.HasDollarVolume_20D = optional(c.DollarVolume20d)
	out.BreakoutDate = dateString(c.BreakoutDate)
	out.ShortReportDate, out.ShortAvailableDate = shortDatesProto(c.ShortReportDate, c.ShortAvailableDate)
	// The date is the report the figure came from, so the status follows the
	// figure. A figure with no matching report row has no date.
	if c.ShortPct != nil {
		out.ShortStatus = "reported"
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

func ruleResultsProto(results []engine.RuleResult) []*shortsv1alpha1.RuleResult {
	out := make([]*shortsv1alpha1.RuleResult, 0, len(results))
	for _, r := range results {
		out = append(out, &shortsv1alpha1.RuleResult{
			RuleId:       r.RuleID,
			Status:       string(r.Status),
			Detail:       r.Detail,
			Value:        r.Value,
			HasValue:     r.HasValue,
			Reason:       r.Reason,
			Proximity:    r.Proximity,
			HasProximity: r.HasProximity,
			Waiting:      r.Waiting,
		})
	}
	return out
}

// pickFundamentalsProto is the fundamentals behind one pick's growth cells,
// with their basis, period and provenance, and headline ratios (plan
// fundamentals-coverage.md §5.2). nil when the stock has no fundamentals row.
// The candidate is prepared (financials decided, valuation computed), so a
// not-meaningful ratio is already absent here and named in not_meaningful.
func pickFundamentalsProto(c *engine.Candidate) *shortsv1alpha1.PickFundamentals {
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
	out.IsFinancial, _, out.NotMeaningful = engine.FinancialFlags(c.Quality, c.Industry)
	if fetched != nil {
		out.FetchedAt = fetched.UTC().Format(time.RFC3339)
	}
	return out
}

// revenueBasisPeriodType is the series revenue growth used; a growth row from
// before the half basis existed carries no type and was always annual.
func revenueBasisPeriodType(g *engine.Growth) string {
	if g.RevenueBasisPeriodType == "" {
		return "annual"
	}
	return g.RevenueBasisPeriodType
}

// revenuePeriodEnd is the end of the latest period in the revenue pair: the
// view's own column when 000132 supplies it, else the date the basis implies.
func revenuePeriodEnd(g *engine.Growth) *time.Time {
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
