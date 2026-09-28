package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

// GetStockStrategyFit returns how one stock reads against every strategy
// (docs/plans/fundamentals-coverage.md §5.2), for the stock page.
//
// It reuses the cached universe and the cached ranked lists, so a pick's
// status, score, rank and rule results here are exactly the ones its row
// carries on /picks/<id>. A stock that is in the universe but is not a
// strategy's pick is re-evaluated (strategies.EvaluateOne) against the SAME
// cached environment, the regime and the universe's rs_6m quartile, and
// reported with status "none", score 0 and rank 0. A stock outside the
// universe (no price features yet) gets no fits and in_universe false, a
// successful response.
func (s *ShortsServer) GetStockStrategyFit(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockStrategyFitRequest]) (*connect.Response[shortsv1alpha1.GetStockStrategyFitResponse], error) {
	if err := validateStockCode(req.Msg.StockCode, "stock_code"); err != nil {
		return nil, err
	}
	code := NormalizeStockCode(req.Msg.StockCode)

	u, err := s.loadStrategyUniverse(ctx)
	if err != nil {
		s.logger.Errorf("database error in GetStockStrategyFit: stock_code=%s err=%v", code, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to evaluate strategies"))
	}
	resp := &shortsv1alpha1.GetStockStrategyFitResponse{
		StockCode: code,
		AsOf:      u.asOf,
		Regime:    marketRegimeProto(u.regime, strategies.NeutralRegimeVerdict(u.regime)),
		Fits:      []*shortsv1alpha1.StrategyFit{},
	}
	if _, ok := u.index[code]; !ok {
		return connect.NewResponse(resp), nil
	}
	resp.InUniverse = true

	for _, st := range strategies.Registry() {
		eval, err := s.loadStrategyEvaluation(ctx, st)
		if err != nil {
			s.logger.Errorf("database error in GetStockStrategyFit: stock_code=%s strategy_id=%s err=%v", code, st.ID, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to evaluate strategies"))
		}
		fit := &shortsv1alpha1.StrategyFit{
			StrategyId:   st.ID,
			StrategyName: st.Name,
			TotalCount:   int32(len(eval.picks)),
		}
		if i, ok := eval.index[code]; ok {
			p := &eval.picks[i]
			fit.Status = string(p.Status)
			fit.Score = p.Score
			fit.Rank = int32(p.Rank)
			fit.Rules = ruleResultsProto(p.Rules)
		} else {
			// The evaluation's own universe (the same fill, unless it
			// expired between the two cache reads).
			eu := eval.universe
			ci, ok := eu.index[code]
			if !ok {
				eu, ci = u, u.index[code]
			}
			p, _ := strategies.EvaluateOne(st, eu.candidates[ci], eu.env)
			fit.Status = string(strategies.StatusNone)
			fit.Rules = ruleResultsProto(p.Rules)
		}
		resp.Fits = append(resp.Fits, fit)
	}
	return connect.NewResponse(resp), nil
}
