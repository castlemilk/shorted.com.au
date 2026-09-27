package shorts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

const (
	fundamentalsDefaultLimit = 12
	fundamentalsMaxLimit     = 40
)

// errFundamentalsStockNotFound marks a code that is unknown to
// company-metadata AND has no fundamentals rows. It is returned from inside
// the cache fill so the NotFound is never cached.
var errFundamentalsStockNotFound = errors.New("stock not found")

// GetStockFundamentals returns a stock's reported periods (newest first) and
// its growth row. Every figure carries a has_* flag: a missing value is
// absent, never zero. NotFound only when the code is unknown to
// company-metadata AND has no rows; a known stock without fundamentals yet
// gets an empty, successful response.
func (s *ShortsServer) GetStockFundamentals(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockFundamentalsRequest]) (*connect.Response[shortsv1alpha1.GetStockFundamentalsResponse], error) {
	if err := validateStockCode(req.Msg.StockCode, "stock_code"); err != nil {
		return nil, err
	}
	code := NormalizeStockCode(req.Msg.StockCode)
	periodType := strings.ToLower(strings.TrimSpace(req.Msg.PeriodType))
	if periodType != "" && !shortsstore.FundamentalsPeriodTypes[periodType] {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("period_type must be one of annual, half, quarter or ttm"))
	}
	if req.Msg.Limit < 0 || req.Msg.Limit > fundamentalsMaxLimit {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and %d", fundamentalsMaxLimit))
	}
	limit := req.Msg.Limit
	if limit == 0 {
		limit = fundamentalsDefaultLimit
	}

	s.logger.Debugf("stock fundamentals: stock_code=%s period_type=%s limit=%d", code, periodType, limit)

	fillCtx := context.WithoutCancel(ctx)
	cached, err := s.cache.GetOrSet(s.cache.GetStockFundamentalsKey(code, periodType, limit), func() (interface{}, error) {
		periods, err := s.store.GetStockFundamentals(fillCtx, code, periodType, limit)
		if err != nil {
			return nil, err
		}
		growth, err := s.store.GetFundamentalsGrowth(fillCtx, code)
		if err != nil {
			return nil, err
		}
		if len(periods) == 0 && growth == nil {
			exists, err := s.store.StockExists(code)
			if err != nil {
				return nil, err
			}
			if !exists {
				return nil, errFundamentalsStockNotFound
			}
		}
		return buildFundamentalsResponse(code, periods, growth), nil
	})
	if err != nil {
		if errors.Is(err, errFundamentalsStockNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("stock not found: %s", code))
		}
		s.logger.Errorf("database error in GetStockFundamentals: stock_code=%s err=%v", code, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get stock fundamentals"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetStockFundamentalsResponse)), nil
}

func buildFundamentalsResponse(code string, periods []shortsstore.FundamentalsPeriodRow, growth *strategies.Growth) *shortsv1alpha1.GetStockFundamentalsResponse {
	resp := &shortsv1alpha1.GetStockFundamentalsResponse{
		StockCode: code,
		Periods:   make([]*shortsv1alpha1.FundamentalsPeriod, 0, len(periods)),
	}
	for _, p := range periods {
		fp := &shortsv1alpha1.FundamentalsPeriod{
			PeriodType: p.PeriodType,
			PeriodEnd:  p.PeriodEnd.Format("2006-01-02"),
			Currency:   p.Currency,
			Source:     p.Source,
		}
		if p.FiscalYear != nil {
			fp.FiscalYear = *p.FiscalYear
		}
		if !p.SourceFetchedAt.IsZero() {
			fp.FetchedAt = p.SourceFetchedAt.UTC().Format(time.RFC3339)
		}
		fp.Revenue, fp.HasRevenue = optional(p.Revenue)
		fp.NetIncome, fp.HasNetIncome = optional(p.NetIncome)
		fp.EpsBasic, fp.HasEpsBasic = optional(p.EPSBasic)
		fp.EpsDiluted, fp.HasEpsDiluted = optional(p.EPSDiluted)
		fp.OperatingCashFlow, fp.HasOperatingCashFlow = optional(p.OperatingCashFlow)
		fp.FreeCashFlow, fp.HasFreeCashFlow = optional(p.FreeCashFlow)
		fp.SharesOutstanding, fp.HasSharesOutstanding = optional(p.SharesOutstanding)
		resp.Periods = append(resp.Periods, fp)
	}
	if growth != nil {
		fg := &shortsv1alpha1.FundamentalsGrowth{
			BasisPeriodType:        growth.BasisPeriodType,
			RevenueBasisPeriodType: growth.RevenueBasisPeriodType,
			PeriodsAvailable:       growth.PeriodsAvailable,
		}
		if growth.LatestPeriodEnd != nil {
			fg.LatestPeriodEnd = growth.LatestPeriodEnd.Format("2006-01-02")
		}
		if growth.HalfLatestPeriodEnd != nil {
			fg.HalfLatestPeriodEnd = growth.HalfLatestPeriodEnd.Format("2006-01-02")
		}
		if growth.NetIncomePositive != nil {
			fg.NetIncomePositive = *growth.NetIncomePositive
		}
		fg.RevenueYoyPct, fg.HasRevenueYoy = optional(growth.RevenueYoYPct)
		fg.RevenueYoyPriorPct, fg.HasRevenueYoyPrior = optional(growth.RevenueYoYPriorPct)
		fg.EpsYoyPct, fg.HasEpsYoy = optional(growth.EPSYoYPct)
		fg.EpsYoyPriorPct, fg.HasEpsYoyPrior = optional(growth.EPSYoYPriorPct)
		fg.RevenueTtm, fg.HasRevenueTtm = optional(growth.RevenueTTM)
		fg.NetIncomeTtm, fg.HasNetIncomeTtm = optional(growth.NetIncomeTTM)
		fg.EpsTtm, fg.HasEpsTtm = optional(growth.EPSTTM)
		fg.RevenueHalfYoyPct, fg.HasRevenueHalfYoy = optional(growth.RevenueHalfYoYPct)
		fg.EpsHalfYoyPct, fg.HasEpsHalfYoy = optional(growth.EPSHalfYoYPct)
		resp.Growth = fg
		resp.HasGrowth = true
	}
	return resp
}

// optional splits a nullable float into a proto3 value and its has_* flag.
func optional(v *float64) (float64, bool) {
	if v == nil {
		return 0, false
	}
	return *v, true
}
