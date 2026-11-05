package shorts

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The saved-strategy rpcs (VISIBILITY_PRIVATE). Every one acts only on the
// verified caller's own rows: the owner is the uid privateAccess returns, and
// no request field names one. A variant reference is resolved under that same
// uid in the store, so another user's variant reads as not found.

// variantIDPattern is the id a variant reference may carry after "variant:".
var variantIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// errSavedStrategyLimit is the refusal for a save past the cap. The web reads
// its connect code (FailedPrecondition) and the message as the limit copy.
func errSavedStrategyLimit() error {
	return connect.NewError(connect.CodeFailedPrecondition,
		fmt.Errorf("you can save up to %d strategies; remove one to save another", shortsstore.MaxSavedStrategies))
}

// parseStrategyRef resolves a request's reference to its stored form: a
// canonical strategy id, lower case, or "variant:<id>". An unknown strategy is
// NotFound, the same answer GetStrategyPicks gives.
func parseStrategyRef(raw string) (string, error) {
	ref := strings.TrimSpace(raw)
	if ref == "" {
		return "", connect.NewError(connect.CodeInvalidArgument, errors.New("strategy_ref is required"))
	}
	if id, ok := strings.CutPrefix(strings.ToLower(ref), "variant:"); ok {
		if !variantIDPattern.MatchString(id) {
			return "", connect.NewError(connect.CodeInvalidArgument, errors.New("strategy_ref names no valid variant"))
		}
		// The id keeps the case it was given: variant ids are stored as written.
		return "variant:" + ref[len("variant:"):], nil
	}
	id := strings.ToLower(ref)
	if _, ok := engine.Lookup(id); !ok {
		return "", connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown strategy_ref %q (one of %s)", raw, strategyIDList()))
	}
	return id, nil
}

// SaveStrategy adds a strategy to the caller's list. A repeat save succeeds.
func (s *ShortsServer) SaveStrategy(ctx context.Context, req *connect.Request[shortsv1alpha1.SaveStrategyRequest]) (*connect.Response[shortsv1alpha1.SaveStrategyResponse], error) {
	_, uid, err := privateAccess(ctx)
	if err != nil {
		return nil, err
	}
	ref, err := parseStrategyRef(req.Msg.StrategyRef)
	if err != nil {
		return nil, err
	}
	if s.strategySaves == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("saved strategies are not available"))
	}
	row, err := s.strategySaves.SaveStrategy(ctx, uid, ref)
	switch {
	case errors.Is(err, shortsstore.ErrStrategySaveLimit):
		return nil, errSavedStrategyLimit()
	case errors.Is(err, shortsstore.ErrStrategyRefNotFound):
		return nil, connect.NewError(connect.CodeNotFound, errors.New("strategy_ref not found"))
	case errors.Is(err, shortsstore.ErrRelationMissing):
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("saved strategies are not available"))
	case err != nil:
		s.logger.Errorf("save strategy failed: ref=%s err=%v", ref, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to save strategy"))
	}
	return connect.NewResponse(&shortsv1alpha1.SaveStrategyResponse{Saved: s.savedStrategyProto(ctx, row)}), nil
}

// UnsaveStrategy removes a strategy from the caller's list. A strategy that is
// not saved is not an error.
func (s *ShortsServer) UnsaveStrategy(ctx context.Context, req *connect.Request[shortsv1alpha1.UnsaveStrategyRequest]) (*connect.Response[shortsv1alpha1.UnsaveStrategyResponse], error) {
	_, uid, err := privateAccess(ctx)
	if err != nil {
		return nil, err
	}
	ref := strings.TrimSpace(req.Msg.StrategyRef)
	if ref == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("strategy_ref is required"))
	}
	if s.strategySaves == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("saved strategies are not available"))
	}
	// A stored reference is already in its canonical form, so the same
	// normalisation SaveStrategy applied is applied here before the delete.
	stored, err := normaliseStoredRef(ref)
	if err != nil {
		return nil, err
	}
	if err := s.strategySaves.UnsaveStrategy(ctx, uid, stored); err != nil {
		if errors.Is(err, shortsstore.ErrRelationMissing) {
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("saved strategies are not available"))
		}
		s.logger.Errorf("unsave strategy failed: ref=%s err=%v", stored, err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to remove strategy"))
	}
	return connect.NewResponse(&shortsv1alpha1.UnsaveStrategyResponse{}), nil
}

// normaliseStoredRef gives an unsave the form a save stored, without the
// registry check: a strategy retired from the registry can still be removed.
func normaliseStoredRef(raw string) (string, error) {
	if id, ok := strings.CutPrefix(strings.ToLower(raw), "variant:"); ok {
		if !variantIDPattern.MatchString(id) {
			return "", connect.NewError(connect.CodeInvalidArgument, errors.New("strategy_ref names no valid variant"))
		}
		return "variant:" + raw[len("variant:"):], nil
	}
	return strings.ToLower(raw), nil
}

// ListSavedStrategies returns the caller's saves, most recent first, each with
// today's status counts when the strategy can be evaluated.
func (s *ShortsServer) ListSavedStrategies(ctx context.Context, _ *connect.Request[shortsv1alpha1.ListSavedStrategiesRequest]) (*connect.Response[shortsv1alpha1.ListSavedStrategiesResponse], error) {
	_, uid, err := privateAccess(ctx)
	if err != nil {
		return nil, err
	}
	if s.strategySaves == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("saved strategies are not available"))
	}
	rows, err := s.strategySaves.ListStrategySaves(ctx, uid)
	if err != nil {
		s.logger.Errorf("list strategy saves failed: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to list saved strategies"))
	}
	out := make([]*shortsv1alpha1.SavedStrategy, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.savedStrategyProto(ctx, row))
	}
	return connect.NewResponse(&shortsv1alpha1.ListSavedStrategiesResponse{
		Strategies: out,
		Limit:      int32(shortsstore.MaxSavedStrategies),
	}), nil
}

// savedStrategyProto is one save as the API reports it. A canonical strategy
// carries its name and today's counts; a count that cannot be read is left
// out rather than failing the list.
func (s *ShortsServer) savedStrategyProto(ctx context.Context, row shortsstore.StrategySaveRow) *shortsv1alpha1.SavedStrategy {
	out := &shortsv1alpha1.SavedStrategy{
		StrategyRef: row.StrategyRef,
		SavedAt:     row.SavedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
	if strings.HasPrefix(row.StrategyRef, "variant:") {
		return out
	}
	st, ok := engine.Lookup(row.StrategyRef)
	if !ok {
		return out
	}
	out.StrategyId = st.ID
	out.Name = st.Name
	eval, err := s.loadStrategyEvaluation(ctx, st)
	if err != nil {
		s.logger.Warnf("saved strategy counts unavailable: strategy_id=%s err=%v", st.ID, err)
		return out
	}
	out.StatusCounts = statusCounts(eval.picks)
	return out
}
