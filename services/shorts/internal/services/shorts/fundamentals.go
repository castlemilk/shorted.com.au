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

// GetStockFundamentals returns a stock's reported periods (newest first), its
// growth row, its quality ratios and valuation, whether its fundamentals have
// been collected, and the summary of the filing behind its latest period
// (docs/plans/fundamentals-coverage.md §5.1, §5.3). Every figure carries a
// has_* flag: a missing value is absent, never zero. NotFound only when the
// code is unknown to company-metadata AND has no rows; a known stock without
// fundamentals yet gets an empty, successful response with its coverage.
//
// A database without migration 000132 answers as today: periods with the
// 000129 lines, the growth row, no quality, coverage status "" and no latest
// filing (the store degrades every 000132 read, never a 500).
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
		in := fundamentalsInputs{code: code}
		var err error
		if in.periods, err = s.store.GetStockFundamentals(fillCtx, code, periodType, limit); err != nil {
			return nil, err
		}
		if in.growth, err = s.store.GetFundamentalsGrowth(fillCtx, code); err != nil {
			return nil, err
		}
		if len(in.periods) == 0 && in.growth == nil {
			exists, err := s.store.StockExists(code)
			if err != nil {
				return nil, err
			}
			if !exists {
				return nil, errFundamentalsStockNotFound
			}
		} else {
			// Ratios, valuation and the latest filing only exist for a stock
			// with rows.
			if in.extras, err = s.store.GetFundamentalsExtras(fillCtx, code); err != nil {
				return nil, err
			}
			if in.filing, err = s.store.GetLatestFilingInputs(fillCtx, code); err != nil {
				return nil, err
			}
		}
		if in.coverage, err = s.store.GetFundamentalsCoverage(fillCtx, code); err != nil {
			return nil, err
		}
		return buildFundamentalsResponse(in), nil
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

// fundamentalsInputs is everything one GetStockFundamentals response is
// built from. Every field but code may be nil / empty.
type fundamentalsInputs struct {
	code     string
	periods  []shortsstore.FundamentalsPeriodRow
	growth   *strategies.Growth
	extras   *shortsstore.FundamentalsExtras
	coverage *shortsstore.FundamentalsCoverageRow
	filing   *shortsstore.LatestFilingInputs
}

func buildFundamentalsResponse(in fundamentalsInputs) *shortsv1alpha1.GetStockFundamentalsResponse {
	resp := &shortsv1alpha1.GetStockFundamentalsResponse{
		StockCode: in.code,
		Periods:   make([]*shortsv1alpha1.FundamentalsPeriod, 0, len(in.periods)),
	}
	for _, p := range in.periods {
		resp.Periods = append(resp.Periods, fundamentalsPeriodProto(p))
	}
	if in.growth != nil {
		in.extras.ApplyToGrowth(in.growth)
		resp.Growth = fundamentalsGrowthProto(in.growth)
		resp.HasGrowth = true
	}
	if q := fundamentalsQualityProto(in.extras); q != nil {
		resp.Quality, resp.HasQuality = q, true
	}
	resp.Coverage = fundamentalsCoverageProto(in.coverage)
	if f := selectLatestFiling(in.filing); f != nil {
		resp.LatestFiling, resp.HasLatestFiling = f, true
	}
	return resp
}

func fundamentalsPeriodProto(p shortsstore.FundamentalsPeriodRow) *shortsv1alpha1.FundamentalsPeriod {
	fp := &shortsv1alpha1.FundamentalsPeriod{
		PeriodType:         p.PeriodType,
		PeriodEnd:          p.PeriodEnd.Format("2006-01-02"),
		Currency:           p.Currency,
		Source:             p.Source,
		SourceDocumentUrl:  p.SourceDocumentURL,
		SourceDocumentDate: dateString(p.SourceDocumentDate),
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

	fp.GrossProfit, fp.HasGrossProfit = optional(p.GrossProfit)
	fp.OperatingIncome, fp.HasOperatingIncome = optional(p.OperatingIncome)
	fp.Ebitda, fp.HasEbitda = optional(p.EBITDA)
	fp.NormalizedEbitda, fp.HasNormalizedEbitda = optional(p.NormalizedEBITDA)
	fp.Ebit, fp.HasEbit = optional(p.EBIT)
	fp.InterestExpense, fp.HasInterestExpense = optional(p.InterestExpense)
	fp.PretaxIncome, fp.HasPretaxIncome = optional(p.PretaxIncome)
	fp.TaxProvision, fp.HasTaxProvision = optional(p.TaxProvision)
	fp.NetInterestIncome, fp.HasNetInterestIncome = optional(p.NetInterestIncome)
	fp.CapitalExpenditure, fp.HasCapitalExpenditure = optional(p.CapitalExpenditure)
	fp.DividendsPaid, fp.HasDividendsPaid = optional(p.DividendsPaid)
	fp.ShareBuybacks, fp.HasShareBuybacks = optional(p.ShareBuybacks)
	fp.TotalAssets, fp.HasTotalAssets = optional(p.TotalAssets)
	fp.TotalLiabilities, fp.HasTotalLiabilities = optional(p.TotalLiabilities)
	fp.TotalEquity, fp.HasTotalEquity = optional(p.TotalEquity)
	fp.CashAndEquivalents, fp.HasCashAndEquivalents = optional(p.CashAndEquivalents)
	fp.TotalDebt, fp.HasTotalDebt = optional(p.TotalDebt)
	fp.CapitalLeaseObligations, fp.HasCapitalLeaseObligations = optional(p.CapitalLeaseObligations)
	fp.NetDebt, fp.HasNetDebt = optional(p.NetDebt)
	fp.CurrentAssets, fp.HasCurrentAssets = optional(p.CurrentAssets)
	fp.CurrentLiabilities, fp.HasCurrentLiabilities = optional(p.CurrentLiabilities)

	if len(p.FieldSources) > 0 {
		fp.FieldSources = make(map[string]string, len(p.FieldSources))
		for k, v := range p.FieldSources {
			fp.FieldSources[k] = v
		}
	}
	return fp
}

func fundamentalsGrowthProto(g *strategies.Growth) *shortsv1alpha1.FundamentalsGrowth {
	fg := &shortsv1alpha1.FundamentalsGrowth{
		BasisPeriodType:        g.BasisPeriodType,
		RevenueBasisPeriodType: g.RevenueBasisPeriodType,
		PeriodsAvailable:       g.PeriodsAvailable,
		LatestPeriodEnd:        dateString(g.LatestPeriodEnd),
		HalfLatestPeriodEnd:    dateString(g.HalfLatestPeriodEnd),
		RevenueBasisSource:     g.RevenueBasisSource,
		EpsBasisSource:         g.EPSBasisSource,
		RevenueLatestPeriodEnd: dateString(g.RevenueLatestPeriodEnd),
		RevenuePriorPeriodEnd:  dateString(g.RevenuePriorPeriodEnd),
	}
	if g.FetchedAt != nil {
		fg.FetchedAt = g.FetchedAt.UTC().Format(time.RFC3339)
	}
	if g.NetIncomePositive != nil {
		fg.NetIncomePositive = *g.NetIncomePositive
	}
	fg.RevenueYoyPct, fg.HasRevenueYoy = optional(g.RevenueYoYPct)
	fg.RevenueYoyPriorPct, fg.HasRevenueYoyPrior = optional(g.RevenueYoYPriorPct)
	fg.EpsYoyPct, fg.HasEpsYoy = optional(g.EPSYoYPct)
	fg.EpsYoyPriorPct, fg.HasEpsYoyPrior = optional(g.EPSYoYPriorPct)
	fg.RevenueTtm, fg.HasRevenueTtm = optional(g.RevenueTTM)
	fg.NetIncomeTtm, fg.HasNetIncomeTtm = optional(g.NetIncomeTTM)
	fg.EpsTtm, fg.HasEpsTtm = optional(g.EPSTTM)
	fg.RevenueHalfYoyPct, fg.HasRevenueHalfYoy = optional(g.RevenueHalfYoYPct)
	fg.EpsHalfYoyPct, fg.HasEpsHalfYoy = optional(g.EPSHalfYoYPct)
	return fg
}

// fundamentalsQualityProto builds the ratios and valuation of one stock. The
// financials decision (strategies.ApplyQualityRules) runs here, before
// anything leaves the API, so a bank's not-meaningful ratios are withheld and
// listed. Valuation uses the one valuation function every surface uses
// (strategies.Valuate). nil when there is neither a quality row nor any
// valuation figure (and always nil before 000132).
func fundamentalsQualityProto(e *shortsstore.FundamentalsExtras) *shortsv1alpha1.FundamentalsQuality {
	if e == nil {
		return nil
	}
	q := e.Quality
	strategies.ApplyQualityRules(q, e.Industry)
	var (
		closePx float64
		asOf    time.Time
	)
	if e.Close != nil {
		closePx = *e.Close
	}
	if e.PriceAsOf != nil {
		asOf = *e.PriceAsOf
	}
	val := strategies.Valuate(closePx, asOf, &e.Valuation, q)
	if q == nil && !val.HasAny() {
		return nil
	}

	isFinancial, isProperty, notMeaningful := strategies.FinancialFlags(q, e.Industry)
	out := &shortsv1alpha1.FundamentalsQuality{
		IsFinancial:    isFinancial,
		IsProperty:     isProperty,
		NotMeaningful:  notMeaningful,
		PriceAsOf:      dateString(val.PriceAsOf),
		SharesAsOf:     dateString(val.SharesAsOf),
		PeEpsPeriodEnd: dateString(val.PEEPSPeriodEnd),
		PeEpsBasis:     val.PEEPSBasis,
		ValuationNote:  val.Note,
	}
	out.MarketCap, out.HasMarketCap = optional(val.MarketCap)
	out.PeRatio, out.HasPeRatio = optional(val.PERatio)
	out.PriceToBook, out.HasPriceToBook = optional(val.PriceToBook)
	if q == nil {
		return out
	}

	out.BasisPeriodType = q.BasisPeriodType
	out.BasisPeriodEnd = dateString(q.BasisPeriodEnd)
	out.Currency = q.Currency
	out.Source = q.Source
	out.OperatingCashFlowDerived = q.OperatingCashFlowDerived
	out.BalancePeriodEnd = dateString(q.BalancePeriodEnd)
	out.BalanceCurrency = q.BalanceCurrency
	if q.BalanceLagMonths != nil {
		out.BalanceLagMonths = *q.BalanceLagMonths
	}
	out.GrossMarginPct, out.HasGrossMarginPct = optional(q.GrossMarginPct)
	out.OperatingMarginPct, out.HasOperatingMarginPct = optional(q.OperatingMarginPct)
	out.NetMarginPct, out.HasNetMarginPct = optional(q.NetMarginPct)
	out.FcfMarginPct, out.HasFcfMarginPct = optional(q.FCFMarginPct)
	out.FcfConversion, out.HasFcfConversion = optional(q.FCFConversion)
	out.RoePct, out.HasRoePct = optional(q.ROEPct)
	out.RoaPct, out.HasRoaPct = optional(q.ROAPct)
	out.NetDebt, out.HasNetDebt = optional(q.NetDebt)
	out.NetDebtToEbitda, out.HasNetDebtToEbitda = optional(q.NetDebtToEBITDA)
	out.NetDebtToEquity, out.HasNetDebtToEquity = optional(q.NetDebtToEquity)
	out.CurrentRatio, out.HasCurrentRatio = optional(q.CurrentRatio)
	out.InterestCover, out.HasInterestCover = optional(q.InterestCover)
	out.PayoutRatioPct, out.HasPayoutRatioPct = optional(q.PayoutRatioPct)
	return out
}

// Coverage statuses (FundamentalsCoverage.status).
const (
	coverageCovered = "covered"
	coverageEmpty   = "empty"
	coveragePending = "pending"
	coverageFailed  = "failed"
)

// fundamentalsCoverageProto maps the sync facts to a coverage status (plan
// §5.1):
//
//   - "" (unknown) when the sync table's last_outcome column does not exist
//     (a database without 000132): absent is not a status;
//   - "covered" when any row is held;
//   - "pending" when the job has never attempted the code;
//   - "empty" / "failed" from the last attempt's outcome;
//   - "" otherwise (a "loaded" attempt whose rows are gone, a NULL outcome).
//
// nil when the tables themselves are missing.
func fundamentalsCoverageProto(row *shortsstore.FundamentalsCoverageRow) *shortsv1alpha1.FundamentalsCoverage {
	if row == nil {
		return nil
	}
	out := &shortsv1alpha1.FundamentalsCoverage{
		Status:  coverageStatus(row),
		Sources: append([]string(nil), row.Sources...),
	}
	if row.LastAttemptAt != nil {
		out.LastAttemptAt = row.LastAttemptAt.UTC().Format(time.RFC3339)
	}
	if row.LastSuccessAt != nil {
		out.LastSuccessAt = row.LastSuccessAt.UTC().Format(time.RFC3339)
	}
	return out
}

func coverageStatus(row *shortsstore.FundamentalsCoverageRow) string {
	switch {
	case !row.OutcomeKnown:
		return ""
	case len(row.Sources) > 0:
		return coverageCovered
	case !row.HasSyncRow:
		return coveragePending
	}
	switch row.LastOutcome {
	case coverageEmpty:
		return coverageEmpty
	case coverageFailed:
		return coverageFailed
	}
	return ""
}

// optional splits a nullable float into a proto3 value and its has_* flag.
func optional(v *float64) (float64, bool) {
	if v == nil {
		return 0, false
	}
	return *v, true
}

// dateString formats a nullable date as YYYY-MM-DD, "" when nil.
func dateString(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02")
}
