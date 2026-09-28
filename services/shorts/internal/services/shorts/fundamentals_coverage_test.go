package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
)

// expectNo000132Reads expects the three 000132 reads once each and answers
// them the way the store does against a database without 000132: nil, never
// an error.
func expectNo000132Reads(m *mocks.MockShortsStore, code string) {
	m.EXPECT().GetFundamentalsExtras(gomock.Any(), code).Return(nil, nil)
	m.EXPECT().GetLatestFilingInputs(gomock.Any(), code).Return(nil, nil)
	m.EXPECT().GetFundamentalsCoverage(gomock.Any(), code).Return(nil, nil)
}

// Plan fundamentals-coverage.md §1 "absent is not a status": against a
// database without 000132 the response is today's, with nothing invented.
func TestGetStockFundamentals_Without000132IsTodaysResponse(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetStockFundamentals(gomock.Any(), "BHP", "", int32(40)).Return([]shortsstore.FundamentalsPeriodRow{
		{StockCode: "BHP", PeriodType: "annual", PeriodEnd: spDate("2026-06-30"), Currency: "USD", Revenue: f64(5.5e10), Source: "yahoo-timeseries"},
	}, nil)
	mockStore.EXPECT().GetFundamentalsGrowth(gomock.Any(), "BHP").Return(&strategies.Growth{BasisPeriodType: "annual", RevenueYoYPct: f64(3)}, nil)
	mockStore.EXPECT().GetFundamentalsExtras(gomock.Any(), "BHP").Return(nil, nil)
	mockStore.EXPECT().GetLatestFilingInputs(gomock.Any(), "BHP").Return(nil, nil)
	mockStore.EXPECT().GetFundamentalsCoverage(gomock.Any(), "BHP").Return(&shortsstore.FundamentalsCoverageRow{
		Sources: []string{"yahoo-timeseries"}, HasSyncRow: true, OutcomeKnown: false,
	}, nil)

	resp, err := newTestServer(t, mockStore).GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "BHP", Limit: 40}))
	require.NoError(t, err)
	msg := resp.Msg
	require.Len(t, msg.Periods, 1)
	p := msg.Periods[0]
	assert.True(t, p.HasRevenue)
	assert.False(t, p.HasGrossProfit || p.HasTotalEquity || p.HasNetDebt || p.HasCapitalExpenditure)
	assert.Empty(t, p.FieldSources)
	assert.Equal(t, "", p.SourceDocumentUrl)
	require.True(t, msg.HasGrowth)
	assert.Equal(t, "", msg.Growth.RevenueBasisSource, "no 000132: provenance unknown, not vendor")
	assert.False(t, msg.HasQuality)
	assert.Nil(t, msg.Quality)
	assert.False(t, msg.HasLatestFiling)
	require.NotNil(t, msg.Coverage)
	assert.Equal(t, "", msg.Coverage.Status, "without last_outcome the status is unknown, even with rows held")
	assert.Equal(t, []string{"yahoo-timeseries"}, msg.Coverage.Sources)
}

func TestGetStockFundamentals_MapsEveryNewField(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	fy := int32(2026)
	period := shortsstore.FundamentalsPeriodRow{
		StockCode: "CSL", PeriodType: "annual", PeriodEnd: spDate("2026-06-30"), FiscalYear: &fy, Currency: "AUD",
		Revenue: f64(1.5e10), NetIncome: f64(3e9), EPSBasic: f64(6.2), EPSDiluted: f64(6.1),
		OperatingCashFlow: f64(4e9), FreeCashFlow: f64(3.2e9), SharesOutstanding: f64(4.8e8),
		Source: "yahoo-timeseries", SourceFetchedAt: spDate("2026-09-01"),
		GrossProfit: f64(8e9), OperatingIncome: f64(4.1e9), EBITDA: f64(5e9), NormalizedEBITDA: f64(5.1e9), EBIT: f64(4.2e9),
		InterestExpense: f64(3e8), PretaxIncome: f64(3.9e9), TaxProvision: f64(9e8), NetInterestIncome: f64(-3e8),
		CapitalExpenditure: f64(-8e8), DividendsPaid: f64(-1.3e9), ShareBuybacks: f64(0),
		TotalAssets: f64(4e10), TotalLiabilities: f64(2e10), TotalEquity: f64(2e10), CashAndEquivalents: f64(1.5e9),
		TotalDebt: f64(1e10), CapitalLeaseObligations: f64(1e9), NetDebt: f64(7.5e9), CurrentAssets: f64(9e9), CurrentLiabilities: f64(5e9),
		FieldSources:       map[string]string{"operating_cash_flow": "derived:fcf-minus-capex"},
		SourceDocumentURL:  "https://www.asx.com.au/csl-4e.pdf",
		SourceDocumentDate: dayPtr("2026-08-19"),
	}
	mockStore.EXPECT().GetStockFundamentals(gomock.Any(), "CSL", "", int32(40)).Return([]shortsstore.FundamentalsPeriodRow{period}, nil)
	mockStore.EXPECT().GetFundamentalsGrowth(gomock.Any(), "CSL").Return(&strategies.Growth{
		BasisPeriodType: "ttm", RevenueBasisPeriodType: "ttm", RevenueYoYPct: f64(8), FetchedAt: dayPtr("2026-09-01"),
	}, nil)
	mockStore.EXPECT().GetFundamentalsExtras(gomock.Any(), "CSL").Return(&shortsstore.FundamentalsExtras{
		StockCode: "CSL", HasGrowthRow: true, RevenueBasisSource: "filing", EPSBasisSource: "vendor",
		RevenueLatestPeriodEnd: dayPtr("2026-12-31"), RevenuePriorPeriodEnd: dayPtr("2025-12-31"),
		Quality: &strategies.Quality{
			BasisPeriodType: "annual", BasisPeriodEnd: dayPtr("2026-06-30"), Currency: "AUD", Source: "yahoo-timeseries",
			OperatingCashFlowDerived: true, BalancePeriodEnd: dayPtr("2026-06-30"), BalanceCurrency: "AUD",
			BalanceLagMonths: func() *int32 { v := int32(0); return &v }(),
			TotalEquity:      f64(2e10), GrossMarginPct: f64(53.3), OperatingMarginPct: f64(27.3), NetMarginPct: f64(20),
			FCFMarginPct: f64(21.3), FCFConversion: f64(1.07), ROEPct: f64(15.2), ROAPct: f64(7.6), NetDebt: f64(7.5e9),
			NetDebtToEBITDA: f64(1.47), NetDebtToEquity: f64(0.375), CurrentRatio: f64(1.8), InterestCover: f64(13.7), PayoutRatioPct: f64(43.3),
		},
		Valuation: strategies.ValuationInputs{
			Shares: f64(4.8e8), SharesPeriodEnd: dayPtr("2026-06-30"), MedianK: f64(1.0),
			EPSDiluted: f64(6.1), EPSBasic: f64(6.2), EPSPeriodEnd: dayPtr("2026-06-30"), EPSCurrency: "AUD",
		},
		Close: f64(250), PriceAsOf: dayPtr("2026-09-25"), Industry: "Pharmaceuticals, Biotechnology & Life Sciences",
	}, nil)
	mockStore.EXPECT().GetLatestFilingInputs(gomock.Any(), "CSL").Return(&shortsstore.LatestFilingInputs{
		NewestFlowPeriodEnd: dayPtr("2026-06-30"), LatestAnnualPeriodEnd: dayPtr("2026-06-30"), CompanyName: "CSL LIMITED",
		Candidates: []shortsstore.FilingCandidateRow{{
			ReportURL: "https://www.asx.com.au/csl-4e.pdf", Title: "Appendix 4E and Annual Report", ReportDate: dayPtr("2026-08-19"),
			Digest: "CSL grew plasma collections.", DigestConfidence: f64(0.82),
			DocumentMeta: extractiontrust.DocumentMeta{Entity: "CSL Limited", PeriodEnd: "2026-06-30", PeriodType: "annual", ReportKind: "appendix_4e"},
		}},
	}, nil)
	mockStore.EXPECT().GetFundamentalsCoverage(gomock.Any(), "CSL").Return(&shortsstore.FundamentalsCoverageRow{
		Sources: []string{"asx-filing-extraction", "yahoo-timeseries"}, HasSyncRow: true, OutcomeKnown: true, LastOutcome: "loaded",
		LastAttemptAt: dayPtr("2026-09-27"), LastSuccessAt: dayPtr("2026-09-27"),
	}, nil)

	resp, err := newTestServer(t, mockStore).GetStockFundamentals(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{StockCode: "CSL", Limit: 40}))
	require.NoError(t, err)
	msg := resp.Msg

	require.Len(t, msg.Periods, 1)
	p := msg.Periods[0]
	checks := []struct {
		name string
		has  bool
		got  float64
		want float64
	}{
		{"gross_profit", p.HasGrossProfit, p.GrossProfit, 8e9},
		{"operating_income", p.HasOperatingIncome, p.OperatingIncome, 4.1e9},
		{"ebitda", p.HasEbitda, p.Ebitda, 5e9},
		{"normalized_ebitda", p.HasNormalizedEbitda, p.NormalizedEbitda, 5.1e9},
		{"ebit", p.HasEbit, p.Ebit, 4.2e9},
		{"interest_expense", p.HasInterestExpense, p.InterestExpense, 3e8},
		{"pretax_income", p.HasPretaxIncome, p.PretaxIncome, 3.9e9},
		{"tax_provision", p.HasTaxProvision, p.TaxProvision, 9e8},
		{"net_interest_income", p.HasNetInterestIncome, p.NetInterestIncome, -3e8},
		{"capital_expenditure", p.HasCapitalExpenditure, p.CapitalExpenditure, -8e8},
		{"dividends_paid", p.HasDividendsPaid, p.DividendsPaid, -1.3e9},
		{"share_buybacks (a reported zero)", p.HasShareBuybacks, p.ShareBuybacks, 0},
		{"total_assets", p.HasTotalAssets, p.TotalAssets, 4e10},
		{"total_liabilities", p.HasTotalLiabilities, p.TotalLiabilities, 2e10},
		{"total_equity", p.HasTotalEquity, p.TotalEquity, 2e10},
		{"cash_and_equivalents", p.HasCashAndEquivalents, p.CashAndEquivalents, 1.5e9},
		{"total_debt", p.HasTotalDebt, p.TotalDebt, 1e10},
		{"capital_lease_obligations", p.HasCapitalLeaseObligations, p.CapitalLeaseObligations, 1e9},
		{"net_debt", p.HasNetDebt, p.NetDebt, 7.5e9},
		{"current_assets", p.HasCurrentAssets, p.CurrentAssets, 9e9},
		{"current_liabilities", p.HasCurrentLiabilities, p.CurrentLiabilities, 5e9},
	}
	for _, c := range checks {
		assert.True(t, c.has, c.name)
		assert.InDelta(t, c.want, c.got, 1, c.name)
	}
	assert.Equal(t, map[string]string{"operating_cash_flow": "derived:fcf-minus-capex"}, p.FieldSources)
	assert.Equal(t, "https://www.asx.com.au/csl-4e.pdf", p.SourceDocumentUrl)
	assert.Equal(t, "2026-08-19", p.SourceDocumentDate)

	g := msg.Growth
	require.NotNil(t, g)
	assert.Equal(t, "filing", g.RevenueBasisSource)
	assert.Equal(t, "vendor", g.EpsBasisSource)
	assert.Equal(t, "2026-09-01T00:00:00Z", g.FetchedAt)
	assert.Equal(t, "2026-12-31", g.RevenueLatestPeriodEnd)
	assert.Equal(t, "2025-12-31", g.RevenuePriorPeriodEnd)

	require.True(t, msg.HasQuality)
	q := msg.Quality
	assert.Equal(t, "annual", q.BasisPeriodType)
	assert.Equal(t, "2026-06-30", q.BasisPeriodEnd)
	assert.Equal(t, "AUD", q.Currency)
	assert.Equal(t, "AUD", q.BalanceCurrency)
	assert.Equal(t, "2026-06-30", q.BalancePeriodEnd)
	assert.Equal(t, "yahoo-timeseries", q.Source)
	assert.True(t, q.OperatingCashFlowDerived)
	assert.False(t, q.IsFinancial)
	assert.False(t, q.IsProperty)
	assert.Empty(t, q.NotMeaningful)
	for name, pair := range map[string][2]any{
		"gross_margin_pct": {q.HasGrossMarginPct, q.GrossMarginPct}, "operating_margin_pct": {q.HasOperatingMarginPct, q.OperatingMarginPct},
		"net_margin_pct": {q.HasNetMarginPct, q.NetMarginPct}, "fcf_margin_pct": {q.HasFcfMarginPct, q.FcfMarginPct},
		"fcf_conversion": {q.HasFcfConversion, q.FcfConversion}, "roe_pct": {q.HasRoePct, q.RoePct}, "roa_pct": {q.HasRoaPct, q.RoaPct},
		"net_debt": {q.HasNetDebt, q.NetDebt}, "net_debt_to_ebitda": {q.HasNetDebtToEbitda, q.NetDebtToEbitda},
		"net_debt_to_equity": {q.HasNetDebtToEquity, q.NetDebtToEquity}, "current_ratio": {q.HasCurrentRatio, q.CurrentRatio},
		"interest_cover": {q.HasInterestCover, q.InterestCover}, "payout_ratio_pct": {q.HasPayoutRatioPct, q.PayoutRatioPct},
	} {
		assert.True(t, pair[0].(bool), name)
		assert.NotZero(t, pair[1].(float64), name)
	}
	assert.True(t, q.HasMarketCap)
	assert.InDelta(t, 250*4.8e8, q.MarketCap, 1)
	assert.True(t, q.HasPeRatio)
	assert.InDelta(t, 250/6.1, q.PeRatio, 1e-9)
	assert.Equal(t, "diluted", q.PeEpsBasis)
	assert.Equal(t, "2026-06-30", q.PeEpsPeriodEnd)
	assert.True(t, q.HasPriceToBook)
	assert.InDelta(t, 250*4.8e8/2e10, q.PriceToBook, 1e-9)
	assert.Equal(t, "2026-09-25", q.PriceAsOf)
	assert.Equal(t, "2026-06-30", q.SharesAsOf)
	assert.Equal(t, "", q.ValuationNote)

	require.NotNil(t, msg.Coverage)
	assert.Equal(t, "covered", msg.Coverage.Status)
	assert.Equal(t, []string{"asx-filing-extraction", "yahoo-timeseries"}, msg.Coverage.Sources)
	assert.Equal(t, "2026-09-27T00:00:00Z", msg.Coverage.LastSuccessAt)

	require.True(t, msg.HasLatestFiling)
	lf := msg.LatestFiling
	assert.Equal(t, "https://www.asx.com.au/csl-4e.pdf", lf.ReportUrl)
	assert.Equal(t, "Appendix 4E and Annual Report", lf.ReportTitle)
	assert.Equal(t, "2026-08-19", lf.ReportDate)
	assert.Equal(t, "2026-06-30", lf.PeriodEnd)
	assert.Equal(t, "annual", lf.PeriodType)
	assert.Equal(t, "CSL grew plasma collections.", lf.Digest)
	assert.InDelta(t, 0.82, lf.DigestConfidence, 1e-9)
}

// Plan §2.7: financials are decided in Go, once, before anything leaves the
// API: the not-meaningful ratios are withheld AND listed.
func TestFundamentalsQualityProto_WithholdsNotMeaningfulRatiosForABank(t *testing.T) {
	e := &shortsstore.FundamentalsExtras{
		Industry: "Banks",
		Quality: &strategies.Quality{
			Currency: "AUD", BalanceCurrency: "AUD", TotalEquity: f64(8e10),
			GrossMarginPct: f64(1), OperatingMarginPct: f64(2), FCFMarginPct: f64(3), FCFConversion: f64(4),
			NetDebt: f64(5), NetDebtToEBITDA: f64(6), NetDebtToEquity: f64(7), CurrentRatio: f64(8), InterestCover: f64(9),
			ROEPct: f64(13.1), ROAPct: f64(0.8), NetMarginPct: f64(38), PayoutRatioPct: f64(80),
		},
		Valuation: strategies.ValuationInputs{
			Shares: f64(1.67e9), SharesPeriodEnd: dayPtr("2026-06-30"), MedianK: f64(1),
			EPSDiluted: f64(6.0), EPSPeriodEnd: dayPtr("2026-06-30"), EPSCurrency: "AUD",
		},
		Close: f64(160), PriceAsOf: dayPtr("2026-09-25"),
	}
	q := fundamentalsQualityProto(e)
	require.NotNil(t, q)
	assert.True(t, q.IsFinancial)
	assert.Equal(t, strategies.NotMeaningfulForFinancials(), q.NotMeaningful)
	assert.False(t, q.HasGrossMarginPct || q.HasOperatingMarginPct || q.HasFcfMarginPct || q.HasFcfConversion ||
		q.HasNetDebt || q.HasNetDebtToEbitda || q.HasNetDebtToEquity || q.HasCurrentRatio || q.HasInterestCover)
	assert.True(t, q.HasRoePct && q.HasRoaPct && q.HasNetMarginPct && q.HasPayoutRatioPct)
	assert.True(t, q.HasPeRatio && q.HasPriceToBook && q.HasMarketCap, "valuation is meaningful for a bank")
}

func TestFundamentalsQualityProto_ValuationOnlyAndNothing(t *testing.T) {
	assert.Nil(t, fundamentalsQualityProto(nil))
	assert.Nil(t, fundamentalsQualityProto(&shortsstore.FundamentalsExtras{Industry: "Materials"}), "no row and no valuation: absent")

	usd := &shortsstore.FundamentalsExtras{
		Industry: "Materials",
		Valuation: strategies.ValuationInputs{
			Shares: f64(5.07e9), SharesPeriodEnd: dayPtr("2026-06-30"), MedianK: f64(1),
			EPSDiluted: f64(2.2), EPSPeriodEnd: dayPtr("2026-06-30"), EPSCurrency: "USD",
		},
		Close: f64(45), PriceAsOf: dayPtr("2026-09-25"),
	}
	q := fundamentalsQualityProto(usd)
	require.NotNil(t, q, "a market cap alone is worth returning")
	assert.True(t, q.HasMarketCap)
	assert.False(t, q.HasPeRatio)
	assert.Equal(t, "non-aud", q.ValuationNote)
	assert.Equal(t, "", q.BasisPeriodType)

	reit := &shortsstore.FundamentalsExtras{Industry: "Equity Real Estate Investment Trusts (REITs)", Quality: &strategies.Quality{Currency: "AUD"}}
	q = fundamentalsQualityProto(reit)
	require.NotNil(t, q)
	assert.True(t, q.IsProperty)
	assert.False(t, q.IsFinancial)
}

func TestCoverageStatus(t *testing.T) {
	now := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		row  *shortsstore.FundamentalsCoverageRow
		want string
	}{
		{"columns absent", &shortsstore.FundamentalsCoverageRow{Sources: []string{"yahoo-timeseries"}, HasSyncRow: true}, ""},
		{"rows held", &shortsstore.FundamentalsCoverageRow{Sources: []string{"yahoo-timeseries"}, HasSyncRow: true, OutcomeKnown: true, LastOutcome: "failed"}, "covered"},
		{"never attempted", &shortsstore.FundamentalsCoverageRow{OutcomeKnown: true}, "pending"},
		{"providers hold nothing", &shortsstore.FundamentalsCoverageRow{HasSyncRow: true, OutcomeKnown: true, LastOutcome: "empty", LastAttemptAt: &now}, "empty"},
		{"last attempt failed", &shortsstore.FundamentalsCoverageRow{HasSyncRow: true, OutcomeKnown: true, LastOutcome: "failed"}, "failed"},
		{"loaded but no rows", &shortsstore.FundamentalsCoverageRow{HasSyncRow: true, OutcomeKnown: true, LastOutcome: "loaded"}, ""},
		{"null outcome", &shortsstore.FundamentalsCoverageRow{HasSyncRow: true, OutcomeKnown: true}, ""},
	}
	for _, tc := range cases {
		got := fundamentalsCoverageProto(tc.row)
		require.NotNil(t, got, tc.name)
		assert.Equal(t, tc.want, got.Status, tc.name)
	}
	assert.Nil(t, fundamentalsCoverageProto(nil), "tables absent: no coverage")
}
