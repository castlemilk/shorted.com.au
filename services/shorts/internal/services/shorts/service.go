package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// validate ServerServer implements productpb.ServerService
var _ shortsv1alpha1connect.ShortedStocksServiceHandler = (*ShortsServer)(nil)

func (s *ShortsServer) GetTopShorts(ctx context.Context, req *connect.Request[shortsv1alpha1.GetTopShortsRequest]) (*connect.Response[shortsv1alpha1.GetTopShortsResponse], error) {
	log.Infof("get top shorts, period: %s, limit: %d", req.Msg.GetPeriod(), req.Msg.Limit)
	result, err := s.store.GetTopShorts(req.Msg.GetPeriod(), req.Msg.GetLimit())
	for _, tsData := range result {
		fmt.Printf("Product Code: %s, Number of Points: %d\n", tsData.ProductCode, len(tsData.Points))
	}
	if err != nil {
		return &connect.Response[shortsv1alpha1.GetTopShortsResponse]{}, status.Errorf(codes.NotFound, "error getting top stocks, period: %s, err: %+v", req.Msg.Period, err)
	}
	return connect.NewResponse(&shortsv1alpha1.GetTopShortsResponse{TimeSeries: result}), nil
}

func (s *ShortsServer) GetStock(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockRequest]) (*connect.Response[stocksv1alpha1.Stock], error) {
	log.Infof("update user")
	stock, err := s.store.GetStock(req.Msg.ProductCode)
	if err != nil {
		return &connect.Response[stocksv1alpha1.Stock]{}, fmt.Errorf("error get product, id: %s", req.Msg.ProductCode)
	}
	return connect.NewResponse(stock), nil
}

func (s *ShortsServer) GetStockData(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockDataRequest]) (*connect.Response[stocksv1alpha1.TimeSeriesData], error) {
	log.Infof("update user")
	stock, err := s.store.GetStockData(req.Msg.ProductCode)
	if err != nil {
		return &connect.Response[stocksv1alpha1.TimeSeriesData]{}, fmt.Errorf("error get product, id: %s", req.Msg.ProductCode)
	}
	return connect.NewResponse(stock), nil
}
