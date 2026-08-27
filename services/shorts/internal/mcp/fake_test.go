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
