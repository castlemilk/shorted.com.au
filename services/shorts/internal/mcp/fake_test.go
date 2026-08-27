package mcp

import (
	"context"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// fakeDataSource is the test double every tool test drives.
//
// The generated mocks under services/shorts/internal/services/shorts/mocks
// cover the STORE interface (ShortsStore), not the Connect handlers, so they
// cannot stand in for a DataSource. This is the smallest thing that can: it
// records the request it was handed, which is the half of the contract a
// response assertion alone would miss — a tool that silently drops the caller's
// limit still returns a plausible-looking payload.
//
// One struct rather than one per tool, because DataSource is a single
// interface: a per-tool fake would have to stub the other eight methods anyway.
type fakeDataSource struct {
	// Recorded requests, one field per method. Nil until the method is called,
	// so a test can assert an RPC was NOT reached (validation short-circuits).
	gotStock          *shortsv1alpha1.GetStockRequest
	gotTopShorts      *shortsv1alpha1.GetTopShortsRequest
	gotTreeMap        *shortsv1alpha1.GetIndustryTreeMapRequest
	gotMarketByDate   *shortsv1alpha1.GetMarketByDateRequest
	gotBattlegrounds  *shortsv1alpha1.GetBattlegroundStocksRequest
	gotStockData      *shortsv1alpha1.GetStockDataRequest
	gotStockDetails   *shortsv1alpha1.GetStockDetailsRequest
	gotDirectorTrades *shortsv1alpha1.GetDirectorTradesRequest
	gotPeerComparison *shortsv1alpha1.GetPeerComparisonRequest
	gotSearchStocks   *shortsv1alpha1.SearchStocksRequest
	gotScreenStocks   *shortsv1alpha1.ScreenStocksRequest
	gotStockNews      *shortsv1alpha1.GetStockNewsRequest
	gotListReports    *shortsv1alpha1.ListReportsRequest
	gotWeeklyReport   *shortsv1alpha1.GetWeeklyReportRequest

	gotHousingOverview  *shortsv1alpha1.GetHousingOverviewRequest
	gotHousePriceSeries *shortsv1alpha1.GetHousePriceSeriesRequest
	gotSuburbProfile    *shortsv1alpha1.GetSuburbProfileRequest
	gotSuburbPriceDrops *shortsv1alpha1.ListSuburbPriceDropsRequest

	gotEconomicSeriesList     *shortsv1alpha1.ListEconomicSeriesRequest
	gotEconomicSeries         *shortsv1alpha1.GetEconomicSeriesRequest
	gotStateCompanyAggregates *shortsv1alpha1.GetStateCompanyAggregatesRequest

	gotListPoliticians  *shortsv1alpha1.ListPoliticiansRequest
	gotPolitician       *shortsv1alpha1.GetPoliticianRequest
	gotStockPoliticians *shortsv1alpha1.ListStockPoliticiansRequest

	// Canned responses.
	stock          *stocksv1alpha1.Stock
	topShorts      *shortsv1alpha1.GetTopShortsResponse
	treeMap        *stocksv1alpha1.IndustryTreeMap
	marketByDate   *shortsv1alpha1.GetMarketByDateResponse
	battlegrounds  *shortsv1alpha1.GetBattlegroundStocksResponse
	stockData      *stocksv1alpha1.TimeSeriesData
	stockDetails   *stocksv1alpha1.StockDetails
	directorTrades *shortsv1alpha1.GetDirectorTradesResponse
	peerComparison *shortsv1alpha1.GetPeerComparisonResponse
	searchStocks   *shortsv1alpha1.SearchStocksResponse
	screenStocks   *shortsv1alpha1.ScreenStocksResponse
	stockNews      *shortsv1alpha1.GetStockNewsResponse
	listReports    *shortsv1alpha1.ListReportsResponse
	weeklyReport   *shortsv1alpha1.GetWeeklyReportResponse

	housingOverview  *shortsv1alpha1.GetHousingOverviewResponse
	housePriceSeries *shortsv1alpha1.GetHousePriceSeriesResponse
	suburbProfile    *shortsv1alpha1.GetSuburbProfileResponse
	suburbPriceDrops *shortsv1alpha1.ListSuburbPriceDropsResponse

	economicSeriesList     *shortsv1alpha1.ListEconomicSeriesResponse
	economicSeries         *shortsv1alpha1.GetEconomicSeriesResponse
	stateCompanyAggregates *shortsv1alpha1.GetStateCompanyAggregatesResponse

	listPoliticians  *shortsv1alpha1.ListPoliticiansResponse
	politician       *shortsv1alpha1.GetPoliticianResponse
	stockPoliticians *shortsv1alpha1.ListStockPoliticiansResponse

	// err, when set, is returned by every method — tests set it to drive the
	// error paths.
	err error
}

var _ DataSource = (*fakeDataSource)(nil)

func (f *fakeDataSource) GetStock(_ context.Context, req *connect.Request[shortsv1alpha1.GetStockRequest]) (*connect.Response[stocksv1alpha1.Stock], error) {
	f.gotStock = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.stock), nil
}

func (f *fakeDataSource) GetTopShorts(_ context.Context, req *connect.Request[shortsv1alpha1.GetTopShortsRequest]) (*connect.Response[shortsv1alpha1.GetTopShortsResponse], error) {
	f.gotTopShorts = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.topShorts), nil
}

func (f *fakeDataSource) GetIndustryTreeMap(_ context.Context, req *connect.Request[shortsv1alpha1.GetIndustryTreeMapRequest]) (*connect.Response[stocksv1alpha1.IndustryTreeMap], error) {
	f.gotTreeMap = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.treeMap), nil
}

func (f *fakeDataSource) GetMarketByDate(_ context.Context, req *connect.Request[shortsv1alpha1.GetMarketByDateRequest]) (*connect.Response[shortsv1alpha1.GetMarketByDateResponse], error) {
	f.gotMarketByDate = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.marketByDate), nil
}

func (f *fakeDataSource) GetBattlegroundStocks(_ context.Context, req *connect.Request[shortsv1alpha1.GetBattlegroundStocksRequest]) (*connect.Response[shortsv1alpha1.GetBattlegroundStocksResponse], error) {
	f.gotBattlegrounds = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.battlegrounds), nil
}

func (f *fakeDataSource) GetStockData(_ context.Context, req *connect.Request[shortsv1alpha1.GetStockDataRequest]) (*connect.Response[stocksv1alpha1.TimeSeriesData], error) {
	f.gotStockData = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.stockData), nil
}

func (f *fakeDataSource) GetStockDetails(_ context.Context, req *connect.Request[shortsv1alpha1.GetStockDetailsRequest]) (*connect.Response[stocksv1alpha1.StockDetails], error) {
	f.gotStockDetails = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.stockDetails), nil
}

func (f *fakeDataSource) GetDirectorTrades(_ context.Context, req *connect.Request[shortsv1alpha1.GetDirectorTradesRequest]) (*connect.Response[shortsv1alpha1.GetDirectorTradesResponse], error) {
	f.gotDirectorTrades = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.directorTrades), nil
}

func (f *fakeDataSource) GetPeerComparison(_ context.Context, req *connect.Request[shortsv1alpha1.GetPeerComparisonRequest]) (*connect.Response[shortsv1alpha1.GetPeerComparisonResponse], error) {
	f.gotPeerComparison = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.peerComparison), nil
}

func (f *fakeDataSource) SearchStocks(_ context.Context, req *connect.Request[shortsv1alpha1.SearchStocksRequest]) (*connect.Response[shortsv1alpha1.SearchStocksResponse], error) {
	f.gotSearchStocks = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.searchStocks), nil
}

func (f *fakeDataSource) ScreenStocks(_ context.Context, req *connect.Request[shortsv1alpha1.ScreenStocksRequest]) (*connect.Response[shortsv1alpha1.ScreenStocksResponse], error) {
	f.gotScreenStocks = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.screenStocks), nil
}

func (f *fakeDataSource) GetStockNews(_ context.Context, req *connect.Request[shortsv1alpha1.GetStockNewsRequest]) (*connect.Response[shortsv1alpha1.GetStockNewsResponse], error) {
	f.gotStockNews = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.stockNews), nil
}

func (f *fakeDataSource) ListReports(_ context.Context, req *connect.Request[shortsv1alpha1.ListReportsRequest]) (*connect.Response[shortsv1alpha1.ListReportsResponse], error) {
	f.gotListReports = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.listReports), nil
}

func (f *fakeDataSource) GetWeeklyReport(_ context.Context, req *connect.Request[shortsv1alpha1.GetWeeklyReportRequest]) (*connect.Response[shortsv1alpha1.GetWeeklyReportResponse], error) {
	f.gotWeeklyReport = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.weeklyReport), nil
}

func (f *fakeDataSource) GetHousingOverview(_ context.Context, req *connect.Request[shortsv1alpha1.GetHousingOverviewRequest]) (*connect.Response[shortsv1alpha1.GetHousingOverviewResponse], error) {
	f.gotHousingOverview = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.housingOverview), nil
}

func (f *fakeDataSource) GetHousePriceSeries(_ context.Context, req *connect.Request[shortsv1alpha1.GetHousePriceSeriesRequest]) (*connect.Response[shortsv1alpha1.GetHousePriceSeriesResponse], error) {
	f.gotHousePriceSeries = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.housePriceSeries), nil
}

func (f *fakeDataSource) GetSuburbProfile(_ context.Context, req *connect.Request[shortsv1alpha1.GetSuburbProfileRequest]) (*connect.Response[shortsv1alpha1.GetSuburbProfileResponse], error) {
	f.gotSuburbProfile = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.suburbProfile), nil
}

func (f *fakeDataSource) ListSuburbPriceDrops(_ context.Context, req *connect.Request[shortsv1alpha1.ListSuburbPriceDropsRequest]) (*connect.Response[shortsv1alpha1.ListSuburbPriceDropsResponse], error) {
	f.gotSuburbPriceDrops = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.suburbPriceDrops), nil
}

func (f *fakeDataSource) ListEconomicSeries(_ context.Context, req *connect.Request[shortsv1alpha1.ListEconomicSeriesRequest]) (*connect.Response[shortsv1alpha1.ListEconomicSeriesResponse], error) {
	f.gotEconomicSeriesList = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.economicSeriesList), nil
}

func (f *fakeDataSource) GetEconomicSeries(_ context.Context, req *connect.Request[shortsv1alpha1.GetEconomicSeriesRequest]) (*connect.Response[shortsv1alpha1.GetEconomicSeriesResponse], error) {
	f.gotEconomicSeries = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.economicSeries), nil
}

func (f *fakeDataSource) GetStateCompanyAggregates(_ context.Context, req *connect.Request[shortsv1alpha1.GetStateCompanyAggregatesRequest]) (*connect.Response[shortsv1alpha1.GetStateCompanyAggregatesResponse], error) {
	f.gotStateCompanyAggregates = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.stateCompanyAggregates), nil
}

func (f *fakeDataSource) ListPoliticians(_ context.Context, req *connect.Request[shortsv1alpha1.ListPoliticiansRequest]) (*connect.Response[shortsv1alpha1.ListPoliticiansResponse], error) {
	f.gotListPoliticians = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.listPoliticians), nil
}

func (f *fakeDataSource) GetPolitician(_ context.Context, req *connect.Request[shortsv1alpha1.GetPoliticianRequest]) (*connect.Response[shortsv1alpha1.GetPoliticianResponse], error) {
	f.gotPolitician = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.politician), nil
}

func (f *fakeDataSource) ListStockPoliticians(_ context.Context, req *connect.Request[shortsv1alpha1.ListStockPoliticiansRequest]) (*connect.Response[shortsv1alpha1.ListStockPoliticiansResponse], error) {
	f.gotStockPoliticians = req.Msg
	if f.err != nil {
		return nil, f.err
	}
	return connect.NewResponse(f.stockPoliticians), nil
}
