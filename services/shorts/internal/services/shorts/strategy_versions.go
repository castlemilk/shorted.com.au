package shorts

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Rules versions on the wire. A version is the registered canonical spec of a
// strategy, identified by the hash of its canonical JSON (spec.RulesHash), and
// every response that reports a strategy's reading names the version it was
// read under. Versions are served from code: the registry is the one list of
// what was published, so a response can never name a version the API cannot
// describe. Variants (kind "variant") are never served here.

// versionRefOf is the wire reference to one registered version.
func versionRefOf(r spec.Registered) (*shortsv1alpha1.StrategyVersionRef, error) {
	hash, err := spec.RulesHash(r.Spec)
	if err != nil {
		return nil, err
	}
	status := "superseded"
	if r.Live {
		status = "live"
	}
	return &shortsv1alpha1.StrategyVersionRef{
		StrategyId:    r.Spec.StrategyID,
		Label:         r.Label,
		RulesHash:     hash,
		EngineVersion: engine.Version,
		FeatureSet:    r.Spec.FeatureSet,
		Status:        status,
		Kind:          r.Spec.Kind,
	}, nil
}

// liveVersion is the reference to the version a strategy is evaluated under
// now, or nil when no version is registered for it. The registry guarantees one
// live version per strategy (TestEveryStrategyHasALiveVersion), so nil is a
// programming error that the tests catch, not a state a reader can reach.
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

// liveRulesHash is the rules hash of the live version of a strategy, "" when
// none is registered.
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
// version RPCs.
func versionDetail(r spec.Registered) (*shortsv1alpha1.StrategyVersionDetail, error) {
	ref, err := versionRefOf(r)
	if err != nil {
		return nil, err
	}
	canonical, err := spec.Canonical(r.Spec)
	if err != nil {
		return nil, err
	}
	return &shortsv1alpha1.StrategyVersionDetail{
		Version:       ref,
		Params:        ruleParams(r.Spec),
		Policies:      policyLines(r.Spec),
		Changes:       append([]string(nil), r.Changes...),
		KnownIssues:   append([]string(nil), r.KnownIssues...),
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
	for _, r := range canonicalVersions(id) {
		h, err := spec.RulesHash(r.Spec)
		if err != nil {
			s.logger.Errorf("GetStrategyVersion: hashing %s failed: %v", id, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to read strategy version"))
		}
		if (hash == "" && r.Live) || (hash != "" && h == hash) {
			detail, err := versionDetail(r)
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
	resp := &shortsv1alpha1.ListStrategyVersionsResponse{Versions: []*shortsv1alpha1.StrategyVersionDetail{}}
	for _, r := range canonicalVersions(id) {
		detail, err := versionDetail(r)
		if err != nil {
			s.logger.Errorf("ListStrategyVersions: rendering %s failed: %v", r.Spec.StrategyID, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list strategy versions"))
		}
		resp.Versions = append(resp.Versions, detail)
	}
	return connect.NewResponse(resp), nil
}
