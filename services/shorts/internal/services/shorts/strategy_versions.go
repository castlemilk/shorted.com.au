package shorts

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// Rules versions on the wire. A version is the registered canonical spec of a
// strategy, identified by the hash of its canonical JSON (spec.RulesHash), and
// every response that reports a strategy's reading names the version it was
// read under. Versions are served from code: the registry is the one list of
// what was published, so a response can never name a version the API cannot
// describe. Variants (kind "variant") are never served here.

// versionTable is the table's state of every canonical version, keyed by rules
// hash. known is false when the table is not migrated or the store has no
// reader: the registry's live flag then states the status, and no version
// carries a date.
type versionTable struct {
	known bool
	rows  map[string]shortsstore.CanonicalRuleVersion
}

// versionState is one version's status and dates as the table states them.
type versionState struct {
	status       string
	liveFrom     string
	supersededOn string
	retiredOn    string
}

// stateOf is a registered version's state. A version the table does not record
// yet is a draft; without the table, the registry's live flag answers.
func (t versionTable) stateOf(r spec.Registered, hash string) versionState {
	if !t.known {
		if r.Live {
			return versionState{status: "live"}
		}
		return versionState{status: "superseded"}
	}
	row, ok := t.rows[hash]
	if !ok {
		return versionState{status: "draft"}
	}
	return versionState{status: row.Status, liveFrom: row.LiveFrom, supersededOn: row.SupersededOn, retiredOn: row.RetiredOn}
}

// liveRulesHash is the rules hash the table marks live for a strategy. Without
// a live row (or without the table) it is the registry's live version.
func (t versionTable) liveRulesHash(strategyID string) string {
	for hash, row := range t.rows {
		if row.StrategyID == strategyID && row.Status == "live" {
			return hash
		}
	}
	return liveRulesHash(strategyID)
}

// strategyVersionTableKey and its TTL: the table moves when the job promotes, a
// few times a year, so a read per instance every few minutes is enough.
const (
	strategyVersionTableKey = "strategy_version_table"
	strategyVersionTableTTL = 5 * time.Minute
)

// readVersionTable is the version table, cached per instance. An error is the
// caller's to answer (Unavailable); a missing table is known=false, not an error.
func (s *ShortsServer) readVersionTable(ctx context.Context) (versionTable, error) {
	reader, ok := s.store.(shortsstore.StrategyVersionReader)
	if !ok {
		return versionTable{}, nil
	}
	load := func() (any, error) {
		rows, err := reader.ReadCanonicalRuleVersions(context.WithoutCancel(ctx))
		switch {
		case errors.Is(err, shortsstore.ErrStrategySnapshotUnavailable):
			return versionTable{}, nil
		case err != nil:
			return nil, err
		}
		t := versionTable{known: true, rows: make(map[string]shortsstore.CanonicalRuleVersion, len(rows))}
		for _, r := range rows {
			t.rows[r.RulesHash] = r
		}
		return t, nil
	}
	if s.cache == nil {
		v, err := load()
		if err != nil {
			return versionTable{}, err
		}
		return v.(versionTable), nil
	}
	v, err := s.cache.GetOrSetWithTTL(strategyVersionTableKey, strategyVersionTableTTL, load)
	if err != nil {
		return versionTable{}, err
	}
	return v.(versionTable), nil
}

// versionRefOf is the registry's wire reference to one registered version (no
// table: the status is the registry's live flag, and no date is stated).
func versionRefOf(r spec.Registered) (*shortsv1alpha1.StrategyVersionRef, error) {
	hash, err := spec.RulesHash(r.Spec)
	if err != nil {
		return nil, err
	}
	return versionRefWith(r, hash, versionTable{}.stateOf(r, hash)), nil
}

// versionRefWith is the wire reference to a registered version in a given state.
func versionRefWith(r spec.Registered, hash string, st versionState) *shortsv1alpha1.StrategyVersionRef {
	return &shortsv1alpha1.StrategyVersionRef{
		StrategyId:    r.Spec.StrategyID,
		Label:         r.Label,
		RulesHash:     hash,
		EngineVersion: engine.Version,
		FeatureSet:    r.Spec.FeatureSet,
		Status:        st.status,
		LiveFrom:      st.liveFrom,
		Kind:          r.Spec.Kind,
	}
}

// servedVersion is the registered version one strategy's picks are read under,
// and the session the version went live (the table's live_from; "" when the
// version is the registry's fallback or the views' v0).
type servedVersion struct {
	reg      spec.Registered
	liveFrom string
}

// strategyLiveStore is the live-version read the API resolves against. The
// store implements it beside the snapshot reader; a store without it (a test
// fake) resolves to the registry's live flag.
type strategyLiveStore interface {
	ReadLiveRuleVersions(ctx context.Context) ([]shortsstore.LiveRuleVersion, error)
}

// readLiveVersions is the table's live row per strategy under the snapshot
// source. nil means the table is not migrated, or the store has no reader, so
// the registry's live flag answers. Any other failure is an error: a served
// version is never guessed from a failed read.
func (s *ShortsServer) readLiveVersions(ctx context.Context) (map[string]shortsstore.LiveRuleVersion, error) {
	reader, ok := s.store.(strategyLiveStore)
	if !ok {
		return nil, nil
	}
	rows, err := reader.ReadLiveRuleVersions(ctx)
	switch {
	case errors.Is(err, shortsstore.ErrStrategySnapshotUnavailable):
		return nil, nil
	case err != nil:
		return nil, err
	}
	out := make(map[string]shortsstore.LiveRuleVersion, len(rows))
	for _, r := range rows {
		out[r.StrategyID] = r
	}
	return out, nil
}

// resolveServedOne is the version one strategy is served under for a source.
// Views serve v0 whatever the config says: the views implement v0 only, so a
// fallback from the snapshot never labels v0 output as live. The snapshot
// serves the version the table marks live (the job's promotion, not the
// deploy), and falls back to the registry's live flag only when the table
// has no row for the strategy or the table is not migrated.
func resolveServedOne(strategyID, source string, live map[string]shortsstore.LiveRuleVersion) servedVersion {
	if source != StrategySourceSnapshot {
		r, _ := spec.Version(strategyID, "v0")
		return servedVersion{reg: r}
	}
	if row, ok := live[strategyID]; ok {
		if r, ok := spec.ByHash(row.RulesHash); ok && r.Spec.StrategyID == strategyID {
			return servedVersion{reg: r, liveFrom: row.LiveFrom}
		}
	}
	r, _ := spec.Live(strategyID)
	return servedVersion{reg: r}
}

// resolveServed resolves every strategy the engine evaluates.
func resolveServed(source string, live map[string]shortsstore.LiveRuleVersion) map[string]servedVersion {
	out := make(map[string]servedVersion, len(engine.Registry()))
	for _, st := range engine.Registry() {
		out[st.ID] = resolveServedOne(st.ID, source, live)
	}
	return out
}

// servedRefOf is the wire reference to the version a response names: its status
// is live, because it is the version served now.
func servedRefOf(v servedVersion) *shortsv1alpha1.StrategyVersionRef {
	ref, err := versionRefOf(v.reg)
	if err != nil {
		return nil
	}
	ref.Status = "live"
	ref.LiveFrom = v.liveFrom
	return ref
}

// servedVersionOf is the version a strategy is served under right now. Views
// and a missing universe answer without a read; the snapshot takes the
// universe's resolution so every response names the same version.
func (s *ShortsServer) servedVersionOf(ctx context.Context, strategyID string) servedVersion {
	if s.config.StrategySource != StrategySourceSnapshot {
		return resolveServedOne(strategyID, s.config.StrategySource, nil)
	}
	u, err := s.loadStrategyUniverse(ctx)
	if err != nil {
		s.logger.Warnf("served version of %s unavailable, naming the registry's live version: %v", strategyID, err)
		return resolveServedOne(strategyID, StrategySourceSnapshot, nil)
	}
	return u.served[strategyID]
}

// tableLiveRulesHash is the rules hash the table marks live for a strategy, the
// version the job promotes and the version the events and the version RPC name
// by default, whatever the source serves. It falls back to the registry's live
// flag when the table has no live row or is not migrated; a failed read is an
// error, never a guess.
func (s *ShortsServer) tableLiveRulesHash(ctx context.Context, strategyID string) (string, error) {
	t, err := s.readVersionTable(ctx)
	if err != nil {
		return "", err
	}
	return t.liveRulesHash(strategyID), nil
}

// servedRef is the wire reference to the version served for a strategy, nil
// when none is registered.
func (s *ShortsServer) servedRef(ctx context.Context, strategyID string) *shortsv1alpha1.StrategyVersionRef {
	return servedRefOf(s.servedVersionOf(ctx, strategyID))
}

// servedRulesHash is the rules hash of the version a response names, "" when none.
func (s *ShortsServer) servedRulesHash(ctx context.Context, strategyID string) string {
	return s.servedRef(ctx, strategyID).GetRulesHash()
}

// liveVersion is the reference to the registry's live version of a strategy,
// or nil when none is registered (the registry guarantees one, see
// TestEveryStrategyHasALiveVersion). Served responses use servedRef; this is
// the registry's own answer, for tests and the registry's listing.
func liveVersion(strategyID string) *shortsv1alpha1.StrategyVersionRef {
	r, ok := spec.Live(strategyID)
	if !ok {
		return nil
	}
	ref, err := versionRefOf(r)
	if err != nil {
		return nil
	}
	return ref
}

// liveRulesHash is the registry's live rules hash of a strategy, "" when none.
func liveRulesHash(strategyID string) string {
	if ref := liveVersion(strategyID); ref != nil {
		return ref.GetRulesHash()
	}
	return ""
}

// canonicalVersions returns the published canonical versions of one strategy
// (every strategy when strategyID is ""), in publication order.
func canonicalVersions(strategyID string) []spec.Registered {
	out := make([]spec.Registered, 0, len(spec.Registry()))
	for _, r := range spec.Registry() {
		if r.Spec.Kind != spec.KindCanonical {
			continue
		}
		if strategyID != "" && r.Spec.StrategyID != strategyID {
			continue
		}
		out = append(out, r)
	}
	return out
}

// versionDetail renders one registered version for the changelog and the
// version RPCs, its status and dates as the table states them.
func versionDetail(r spec.Registered, t versionTable) (*shortsv1alpha1.StrategyVersionDetail, error) {
	hash, err := spec.RulesHash(r.Spec)
	if err != nil {
		return nil, err
	}
	st := t.stateOf(r, hash)
	canonical, err := spec.Canonical(r.Spec)
	if err != nil {
		return nil, err
	}
	return &shortsv1alpha1.StrategyVersionDetail{
		Version:       versionRefWith(r, hash, st),
		Params:        ruleParams(r.Spec),
		Policies:      policyLines(r.Spec),
		Changes:       append([]string(nil), r.Changes...),
		KnownIssues:   append([]string(nil), r.KnownIssues...),
		SupersededOn:  st.supersededOn,
		RetiredOn:     st.retiredOn,
		CanonicalJson: string(canonical),
	}, nil
}

// ruleParams lists every numeric parameter of every rule, in rule order and,
// within a rule, by key, so the list is a function of the spec alone.
func ruleParams(s spec.Spec) []*shortsv1alpha1.RuleParam {
	var out []*shortsv1alpha1.RuleParam
	for _, r := range s.Rules {
		keys := make([]string, 0, len(r.Params))
		for k := range r.Params {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			out = append(out, &shortsv1alpha1.RuleParam{RuleId: r.ID, Name: k, Value: r.Params[k]})
		}
	}
	return out
}

// policyLines states the universe and data policy of a version in one
// sentence each, from the spec's own fields. A value the renderer does not
// know contributes no sentence rather than a guess.
func policyLines(s spec.Spec) []string {
	var out []string
	switch s.Universe.Instruments {
	case "all":
		out = append(out, "Candidates are every instrument with price history, exchange-traded products included.")
	case "ordinary":
		out = append(out, "Candidates are ordinary shares only: exchange-traded products and the debt, hybrid, deferred and secondary lines are excluded.")
	}
	out = append(out, fmt.Sprintf("A stock needs at least %d sessions in the last %d days to be evaluated.", s.Universe.MinSessions, s.Universe.LookbackDays))
	switch s.Universe.Freshness {
	case "none":
		out = append(out, "There is no freshness check: a code keeps its last features after its price stops.")
	case "bar_on_session":
		out = append(out, "A price bar on the session is required; a suspended or delisted code is not evaluated.")
	}
	switch s.Data.ShortSource {
	case "latest_nonzero_row":
		out = append(out, "Short interest is the stock's latest non-zero row in the ASIC data, with no age limit.")
	case "latest_complete_published":
		out = append(out, fmt.Sprintf("Short interest is the stock's row in the latest complete ASIC report published by the session, T+%d sessions, no older than %d sessions; a stock absent from it has no reportable position.", s.Data.PublicationLagSessions, s.Data.MaxReportAgeSessions))
	}
	switch s.Data.DTC {
	case "v0_35d_nonzero_bigint":
		out = append(out, "Days to cover averages the non-zero volume over 35 calendar days.")
	case "v1_20_bars_min10_traded":
		out = append(out, "Days to cover averages the volume of the last 20 bars, zero-volume bars included; unknown when fewer than 10 of them traded.")
	}
	switch s.Universe.RSPopulation {
	case "candidates":
		out = append(out, "Relative strength is ranked among the candidates.")
	case "universe":
		out = append(out, "Relative strength is ranked across the whole universe.")
	}
	if s.Data.Fundamentals == "live_snapshot" && requiresSource(s, "fundamentals") {
		out = append(out, "Fundamentals are the latest reported as of the previous nightly pull, not point-in-time before November 2026.")
	}
	if s.Ladder.UnknownStatus {
		out = append(out, "A pick is unknown when no core non-trigger rule fails and at least one core rule is unknown.")
	} else {
		out = append(out, "An unknown trigger rule reads as setup.")
	}
	return out
}

// requiresSource reports whether the spec names a data source among its
// requirements.
func requiresSource(s spec.Spec, source string) bool {
	for _, r := range s.Requires {
		if r.Source == source {
			return true
		}
	}
	return false
}

// GetStrategyVersion returns one published version of a strategy's rules. An
// empty version_hash is the live version. Only canonical versions are served:
// an unknown hash, or a hash of another strategy's version, is NotFound.
func (s *ShortsServer) GetStrategyVersion(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStrategyVersionRequest]) (*connect.Response[shortsv1alpha1.GetStrategyVersionResponse], error) {
	id := strings.ToLower(strings.TrimSpace(req.Msg.StrategyId))
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("strategy_id is required (one of %s)", strategyIDList()))
	}
	if _, ok := engine.Lookup(id); !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown strategy_id %q (one of %s)", req.Msg.StrategyId, strategyIDList()))
	}
	hash := strings.ToLower(strings.TrimSpace(req.Msg.VersionHash))
	table, err := s.readVersionTable(ctx)
	if err != nil {
		s.logger.Errorf("GetStrategyVersion: reading the version table for %s failed: %v", id, err)
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("strategy version is not available"))
	}
	liveHash := table.liveRulesHash(id)
	for _, r := range canonicalVersions(id) {
		h, err := spec.RulesHash(r.Spec)
		if err != nil {
			s.logger.Errorf("GetStrategyVersion: hashing %s failed: %v", id, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to read strategy version"))
		}
		if (hash == "" && h == liveHash) || (hash != "" && h == hash) {
			detail, err := versionDetail(r, table)
			if err != nil {
				s.logger.Errorf("GetStrategyVersion: rendering %s failed: %v", id, err)
				return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to read strategy version"))
			}
			return connect.NewResponse(&shortsv1alpha1.GetStrategyVersionResponse{Version: detail}), nil
		}
	}
	if hash == "" {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no live version is registered for %s", id))
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no published version of %s has rules_hash %q", id, req.Msg.VersionHash))
}

// ListStrategyVersions returns every published canonical version, in
// publication order, for one strategy or for all of them when strategy_id is
// empty. An unknown strategy_id is NotFound.
func (s *ShortsServer) ListStrategyVersions(ctx context.Context, req *connect.Request[shortsv1alpha1.ListStrategyVersionsRequest]) (*connect.Response[shortsv1alpha1.ListStrategyVersionsResponse], error) {
	id := strings.ToLower(strings.TrimSpace(req.Msg.StrategyId))
	if id != "" {
		if _, ok := engine.Lookup(id); !ok {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown strategy_id %q (one of %s)", req.Msg.StrategyId, strategyIDList()))
		}
	}
	table, err := s.readVersionTable(ctx)
	if err != nil {
		s.logger.Errorf("ListStrategyVersions: reading the version table failed: %v", err)
		return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("strategy versions are not available"))
	}
	resp := &shortsv1alpha1.ListStrategyVersionsResponse{Versions: []*shortsv1alpha1.StrategyVersionDetail{}}
	for _, r := range canonicalVersions(id) {
		detail, err := versionDetail(r, table)
		if err != nil {
			s.logger.Errorf("ListStrategyVersions: rendering %s failed: %v", r.Spec.StrategyID, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list strategy versions"))
		}
		resp.Versions = append(resp.Versions, detail)
	}
	return connect.NewResponse(resp), nil
}
