package mcp

import (
	"context"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// DataSource is the narrow interface the MCP tools call. It is satisfied by
// *ShortsServer, whose methods are Connect handlers invoked here IN-PROCESS —
// which is precisely why every method listed on it must correspond to a
// VISIBILITY_PUBLIC RPC. See the package doc.
//
// It is narrow deliberately. *ShortsServer implements every rpc on all twelve
// domain services, MintToken among them; naming the handful the tools actually
// need means a tool physically cannot reach the rest, and the interface itself
// is a second, compile-time reading of the surface that
// TestToolsOnlyCallPublicMethods checks at test time.
//
// The signatures are the real Connect handler signatures, copied from the
// domain files in services/shorts/internal/services/shorts. Note that they do
// NOT follow a mechanical Get<X>Request/Get<X>Response pairing: four of the
// nine return a bare type from the shortedtypes `stocks.v1alpha1` package
// (Stock, TimeSeriesData, StockDetails, IndustryTreeMap) rather than a
// <Method>Response wrapper. Read the handler before adding a line here.
type DataSource interface {
	// --- MarketService ---

	// GetTopShorts: shorts.v1alpha1.MarketService.GetTopShorts
	GetTopShorts(context.Context, *connect.Request[shortsv1alpha1.GetTopShortsRequest]) (*connect.Response[shortsv1alpha1.GetTopShortsResponse], error)
	// GetIndustryTreeMap: shorts.v1alpha1.MarketService.GetIndustryTreeMap
	GetIndustryTreeMap(context.Context, *connect.Request[shortsv1alpha1.GetIndustryTreeMapRequest]) (*connect.Response[stocksv1alpha1.IndustryTreeMap], error)
	// GetMarketByDate: shorts.v1alpha1.MarketService.GetMarketByDate
	GetMarketByDate(context.Context, *connect.Request[shortsv1alpha1.GetMarketByDateRequest]) (*connect.Response[shortsv1alpha1.GetMarketByDateResponse], error)
	// GetBattlegroundStocks: shorts.v1alpha1.MarketService.GetBattlegroundStocks
	GetBattlegroundStocks(context.Context, *connect.Request[shortsv1alpha1.GetBattlegroundStocksRequest]) (*connect.Response[shortsv1alpha1.GetBattlegroundStocksResponse], error)

	// --- StockService ---

	// GetStock: shorts.v1alpha1.StockService.GetStock
	GetStock(context.Context, *connect.Request[shortsv1alpha1.GetStockRequest]) (*connect.Response[stocksv1alpha1.Stock], error)
	// GetStockData: shorts.v1alpha1.StockService.GetStockData
	GetStockData(context.Context, *connect.Request[shortsv1alpha1.GetStockDataRequest]) (*connect.Response[stocksv1alpha1.TimeSeriesData], error)
	// GetStockDetails: shorts.v1alpha1.StockService.GetStockDetails
	GetStockDetails(context.Context, *connect.Request[shortsv1alpha1.GetStockDetailsRequest]) (*connect.Response[stocksv1alpha1.StockDetails], error)
	// GetDirectorTrades: shorts.v1alpha1.StockService.GetDirectorTrades
	GetDirectorTrades(context.Context, *connect.Request[shortsv1alpha1.GetDirectorTradesRequest]) (*connect.Response[shortsv1alpha1.GetDirectorTradesResponse], error)
	// GetPeerComparison: shorts.v1alpha1.StockService.GetPeerComparison
	GetPeerComparison(context.Context, *connect.Request[shortsv1alpha1.GetPeerComparisonRequest]) (*connect.Response[shortsv1alpha1.GetPeerComparisonResponse], error)

	// --- SearchService ---

	// SearchStocks: shorts.v1alpha1.SearchService.SearchStocks
	SearchStocks(context.Context, *connect.Request[shortsv1alpha1.SearchStocksRequest]) (*connect.Response[shortsv1alpha1.SearchStocksResponse], error)

	// --- ScreenerService ---

	// ScreenStocks: shorts.v1alpha1.ScreenerService.ScreenStocks
	ScreenStocks(context.Context, *connect.Request[shortsv1alpha1.ScreenStocksRequest]) (*connect.Response[shortsv1alpha1.ScreenStocksResponse], error)

	// --- NewsService ---

	// GetStockNews: shorts.v1alpha1.NewsService.GetStockNews
	GetStockNews(context.Context, *connect.Request[shortsv1alpha1.GetStockNewsRequest]) (*connect.Response[shortsv1alpha1.GetStockNewsResponse], error)

	// --- ReportsService ---

	// ListReports: shorts.v1alpha1.ReportsService.ListReports
	ListReports(context.Context, *connect.Request[shortsv1alpha1.ListReportsRequest]) (*connect.Response[shortsv1alpha1.ListReportsResponse], error)
	// GetWeeklyReport: shorts.v1alpha1.ReportsService.GetWeeklyReport
	GetWeeklyReport(context.Context, *connect.Request[shortsv1alpha1.GetWeeklyReportRequest]) (*connect.Response[shortsv1alpha1.GetWeeklyReportResponse], error)

	// --- HousingService ---
	//
	// Four of fifteen. The eleven left off are not an oversight: the ones that
	// serve individual listings, addresses, agencies or per-address valuations
	// (ListSuburbDropListings, ListAddressPriceDrops, ListAgencyPriceStats,
	// GetPropertyHistory) read rows whose source_licence is
	// 'proprietary-tos-restricted' and which are never republished. Keeping them
	// off this interface is what makes that unreachable from a tool rather than
	// merely unwrapped today.

	// GetHousingOverview: shorts.v1alpha1.HousingService.GetHousingOverview
	GetHousingOverview(context.Context, *connect.Request[shortsv1alpha1.GetHousingOverviewRequest]) (*connect.Response[shortsv1alpha1.GetHousingOverviewResponse], error)
	// GetHousePriceSeries: shorts.v1alpha1.HousingService.GetHousePriceSeries
	GetHousePriceSeries(context.Context, *connect.Request[shortsv1alpha1.GetHousePriceSeriesRequest]) (*connect.Response[shortsv1alpha1.GetHousePriceSeriesResponse], error)
	// GetSuburbProfile: shorts.v1alpha1.HousingService.GetSuburbProfile
	GetSuburbProfile(context.Context, *connect.Request[shortsv1alpha1.GetSuburbProfileRequest]) (*connect.Response[shortsv1alpha1.GetSuburbProfileResponse], error)
	// ListSuburbPriceDrops: shorts.v1alpha1.HousingService.ListSuburbPriceDrops
	ListSuburbPriceDrops(context.Context, *connect.Request[shortsv1alpha1.ListSuburbPriceDropsRequest]) (*connect.Response[shortsv1alpha1.ListSuburbPriceDropsResponse], error)

	// --- EconomyService ---

	// ListEconomicSeries: shorts.v1alpha1.EconomyService.ListEconomicSeries
	ListEconomicSeries(context.Context, *connect.Request[shortsv1alpha1.ListEconomicSeriesRequest]) (*connect.Response[shortsv1alpha1.ListEconomicSeriesResponse], error)
	// GetEconomicSeries: shorts.v1alpha1.EconomyService.GetEconomicSeries
	GetEconomicSeries(context.Context, *connect.Request[shortsv1alpha1.GetEconomicSeriesRequest]) (*connect.Response[shortsv1alpha1.GetEconomicSeriesResponse], error)
	// GetStateCompanyAggregates: shorts.v1alpha1.EconomyService.GetStateCompanyAggregates
	GetStateCompanyAggregates(context.Context, *connect.Request[shortsv1alpha1.GetStateCompanyAggregatesRequest]) (*connect.Response[shortsv1alpha1.GetStateCompanyAggregatesResponse], error)

	// --- PoliticiansService ---
	//
	// Three of nineteen. The AEC funding rpcs on the same service (GetDonations-
	// Overview, ListTopDonors, ListPartyFunding, GetPoliticianFunding) are the
	// only place in that subsystem where AMOUNTS exist, and they are deliberately
	// left off: the register surface must not be one closure away from a dollar
	// figure that a consumer could attach to a declared interest.

	// ListPoliticians: shorts.v1alpha1.PoliticiansService.ListPoliticians
	ListPoliticians(context.Context, *connect.Request[shortsv1alpha1.ListPoliticiansRequest]) (*connect.Response[shortsv1alpha1.ListPoliticiansResponse], error)
	// GetPolitician: shorts.v1alpha1.PoliticiansService.GetPolitician
	GetPolitician(context.Context, *connect.Request[shortsv1alpha1.GetPoliticianRequest]) (*connect.Response[shortsv1alpha1.GetPoliticianResponse], error)
	// ListStockPoliticians: shorts.v1alpha1.PoliticiansService.ListStockPoliticians
	ListStockPoliticians(context.Context, *connect.Request[shortsv1alpha1.ListStockPoliticiansRequest]) (*connect.Response[shortsv1alpha1.ListStockPoliticiansResponse], error)
}
