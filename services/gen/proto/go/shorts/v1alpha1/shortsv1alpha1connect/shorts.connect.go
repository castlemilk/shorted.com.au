// Code generated by protoc-gen-connect-go. DO NOT EDIT.
//
// Source: shorts/v1alpha1/shorts.proto

package shortsv1alpha1connect

import (
	connect "connectrpc.com/connect"
	context "context"
	errors "errors"
	v1alpha1 "github.com/castlemilk/shorted/services/gen/proto/go/shorts/v1alpha1"
	v1alpha11 "github.com/castlemilk/shorted/services/gen/proto/go/stocks/v1alpha1"
	http "net/http"
	strings "strings"
)

// This is a compile-time assertion to ensure that this generated file and the connect package are
// compatible. If you get a compiler error that this constant is not defined, this code was
// generated with a version of connect newer than the one compiled into your binary. You can fix the
// problem by either regenerating this code with an older version of connect or updating the connect
// version compiled into your binary.
const _ = connect.IsAtLeastVersion1_13_0

const (
	// ShortedStocksServiceName is the fully-qualified name of the ShortedStocksService service.
	ShortedStocksServiceName = "shorts.v1alpha1.ShortedStocksService"
)

// These constants are the fully-qualified names of the RPCs defined in this package. They're
// exposed at runtime as Spec.Procedure and as the final two segments of the HTTP route.
//
// Note that these are different from the fully-qualified method names used by
// google.golang.org/protobuf/reflect/protoreflect. To convert from these constants to
// reflection-formatted method names, remove the leading slash and convert the remaining slash to a
// period.
const (
	// ShortedStocksServiceTop10Procedure is the fully-qualified name of the ShortedStocksService's
	// Top10 RPC.
	ShortedStocksServiceTop10Procedure = "/shorts.v1alpha1.ShortedStocksService/Top10"
	// ShortedStocksServiceGetStockProcedure is the fully-qualified name of the ShortedStocksService's
	// GetStock RPC.
	ShortedStocksServiceGetStockProcedure = "/shorts.v1alpha1.ShortedStocksService/GetStock"
	// ShortedStocksServiceGetStockDetailsProcedure is the fully-qualified name of the
	// ShortedStocksService's GetStockDetails RPC.
	ShortedStocksServiceGetStockDetailsProcedure = "/shorts.v1alpha1.ShortedStocksService/GetStockDetails"
	// ShortedStocksServiceGetStockDataProcedure is the fully-qualified name of the
	// ShortedStocksService's GetStockData RPC.
	ShortedStocksServiceGetStockDataProcedure = "/shorts.v1alpha1.ShortedStocksService/GetStockData"
)

// These variables are the protoreflect.Descriptor objects for the RPCs defined in this package.
var (
	shortedStocksServiceServiceDescriptor               = v1alpha1.File_shorts_v1alpha1_shorts_proto.Services().ByName("ShortedStocksService")
	shortedStocksServiceTop10MethodDescriptor           = shortedStocksServiceServiceDescriptor.Methods().ByName("Top10")
	shortedStocksServiceGetStockMethodDescriptor        = shortedStocksServiceServiceDescriptor.Methods().ByName("GetStock")
	shortedStocksServiceGetStockDetailsMethodDescriptor = shortedStocksServiceServiceDescriptor.Methods().ByName("GetStockDetails")
	shortedStocksServiceGetStockDataMethodDescriptor    = shortedStocksServiceServiceDescriptor.Methods().ByName("GetStockData")
)

// ShortedStocksServiceClient is a client for the shorts.v1alpha1.ShortedStocksService service.
type ShortedStocksServiceClient interface {
	// Shows top 10 short positions on the ASX over different periods of time.
	Top10(context.Context, *connect.Request[v1alpha1.Top10Request]) (*connect.Response[v1alpha1.Top10Response], error)
	// Provides an overview of a specific stock based on PRODUCT_CODE.
	GetStock(context.Context, *connect.Request[v1alpha1.StockSummaryRequest]) (*connect.Response[v1alpha11.Stock], error)
	// Provides a more in-depth breakdown of a particular stock's metadata.
	GetStockDetails(context.Context, *connect.Request[v1alpha1.StockDetailsRequest]) (*connect.Response[v1alpha11.StockDetails], error)
	// fetch time series data for a specific stock
	GetStockData(context.Context, *connect.Request[v1alpha1.GetStockDataRequest]) (*connect.Response[v1alpha11.TimeSeriesData], error)
}

// NewShortedStocksServiceClient constructs a client for the shorts.v1alpha1.ShortedStocksService
// service. By default, it uses the Connect protocol with the binary Protobuf Codec, asks for
// gzipped responses, and sends uncompressed requests. To use the gRPC or gRPC-Web protocols, supply
// the connect.WithGRPC() or connect.WithGRPCWeb() options.
//
// The URL supplied here should be the base URL for the Connect or gRPC server (for example,
// http://api.acme.com or https://acme.com/grpc).
func NewShortedStocksServiceClient(httpClient connect.HTTPClient, baseURL string, opts ...connect.ClientOption) ShortedStocksServiceClient {
	baseURL = strings.TrimRight(baseURL, "/")
	return &shortedStocksServiceClient{
		top10: connect.NewClient[v1alpha1.Top10Request, v1alpha1.Top10Response](
			httpClient,
			baseURL+ShortedStocksServiceTop10Procedure,
			connect.WithSchema(shortedStocksServiceTop10MethodDescriptor),
			connect.WithClientOptions(opts...),
		),
		getStock: connect.NewClient[v1alpha1.StockSummaryRequest, v1alpha11.Stock](
			httpClient,
			baseURL+ShortedStocksServiceGetStockProcedure,
			connect.WithSchema(shortedStocksServiceGetStockMethodDescriptor),
			connect.WithClientOptions(opts...),
		),
		getStockDetails: connect.NewClient[v1alpha1.StockDetailsRequest, v1alpha11.StockDetails](
			httpClient,
			baseURL+ShortedStocksServiceGetStockDetailsProcedure,
			connect.WithSchema(shortedStocksServiceGetStockDetailsMethodDescriptor),
			connect.WithClientOptions(opts...),
		),
		getStockData: connect.NewClient[v1alpha1.GetStockDataRequest, v1alpha11.TimeSeriesData](
			httpClient,
			baseURL+ShortedStocksServiceGetStockDataProcedure,
			connect.WithSchema(shortedStocksServiceGetStockDataMethodDescriptor),
			connect.WithClientOptions(opts...),
		),
	}
}

// shortedStocksServiceClient implements ShortedStocksServiceClient.
type shortedStocksServiceClient struct {
	top10           *connect.Client[v1alpha1.Top10Request, v1alpha1.Top10Response]
	getStock        *connect.Client[v1alpha1.StockSummaryRequest, v1alpha11.Stock]
	getStockDetails *connect.Client[v1alpha1.StockDetailsRequest, v1alpha11.StockDetails]
	getStockData    *connect.Client[v1alpha1.GetStockDataRequest, v1alpha11.TimeSeriesData]
}

// Top10 calls shorts.v1alpha1.ShortedStocksService.Top10.
func (c *shortedStocksServiceClient) Top10(ctx context.Context, req *connect.Request[v1alpha1.Top10Request]) (*connect.Response[v1alpha1.Top10Response], error) {
	return c.top10.CallUnary(ctx, req)
}

// GetStock calls shorts.v1alpha1.ShortedStocksService.GetStock.
func (c *shortedStocksServiceClient) GetStock(ctx context.Context, req *connect.Request[v1alpha1.StockSummaryRequest]) (*connect.Response[v1alpha11.Stock], error) {
	return c.getStock.CallUnary(ctx, req)
}

// GetStockDetails calls shorts.v1alpha1.ShortedStocksService.GetStockDetails.
func (c *shortedStocksServiceClient) GetStockDetails(ctx context.Context, req *connect.Request[v1alpha1.StockDetailsRequest]) (*connect.Response[v1alpha11.StockDetails], error) {
	return c.getStockDetails.CallUnary(ctx, req)
}

// GetStockData calls shorts.v1alpha1.ShortedStocksService.GetStockData.
func (c *shortedStocksServiceClient) GetStockData(ctx context.Context, req *connect.Request[v1alpha1.GetStockDataRequest]) (*connect.Response[v1alpha11.TimeSeriesData], error) {
	return c.getStockData.CallUnary(ctx, req)
}

// ShortedStocksServiceHandler is an implementation of the shorts.v1alpha1.ShortedStocksService
// service.
type ShortedStocksServiceHandler interface {
	// Shows top 10 short positions on the ASX over different periods of time.
	Top10(context.Context, *connect.Request[v1alpha1.Top10Request]) (*connect.Response[v1alpha1.Top10Response], error)
	// Provides an overview of a specific stock based on PRODUCT_CODE.
	GetStock(context.Context, *connect.Request[v1alpha1.StockSummaryRequest]) (*connect.Response[v1alpha11.Stock], error)
	// Provides a more in-depth breakdown of a particular stock's metadata.
	GetStockDetails(context.Context, *connect.Request[v1alpha1.StockDetailsRequest]) (*connect.Response[v1alpha11.StockDetails], error)
	// fetch time series data for a specific stock
	GetStockData(context.Context, *connect.Request[v1alpha1.GetStockDataRequest]) (*connect.Response[v1alpha11.TimeSeriesData], error)
}

// NewShortedStocksServiceHandler builds an HTTP handler from the service implementation. It returns
// the path on which to mount the handler and the handler itself.
//
// By default, handlers support the Connect, gRPC, and gRPC-Web protocols with the binary Protobuf
// and JSON codecs. They also support gzip compression.
func NewShortedStocksServiceHandler(svc ShortedStocksServiceHandler, opts ...connect.HandlerOption) (string, http.Handler) {
	shortedStocksServiceTop10Handler := connect.NewUnaryHandler(
		ShortedStocksServiceTop10Procedure,
		svc.Top10,
		connect.WithSchema(shortedStocksServiceTop10MethodDescriptor),
		connect.WithHandlerOptions(opts...),
	)
	shortedStocksServiceGetStockHandler := connect.NewUnaryHandler(
		ShortedStocksServiceGetStockProcedure,
		svc.GetStock,
		connect.WithSchema(shortedStocksServiceGetStockMethodDescriptor),
		connect.WithHandlerOptions(opts...),
	)
	shortedStocksServiceGetStockDetailsHandler := connect.NewUnaryHandler(
		ShortedStocksServiceGetStockDetailsProcedure,
		svc.GetStockDetails,
		connect.WithSchema(shortedStocksServiceGetStockDetailsMethodDescriptor),
		connect.WithHandlerOptions(opts...),
	)
	shortedStocksServiceGetStockDataHandler := connect.NewUnaryHandler(
		ShortedStocksServiceGetStockDataProcedure,
		svc.GetStockData,
		connect.WithSchema(shortedStocksServiceGetStockDataMethodDescriptor),
		connect.WithHandlerOptions(opts...),
	)
	return "/shorts.v1alpha1.ShortedStocksService/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case ShortedStocksServiceTop10Procedure:
			shortedStocksServiceTop10Handler.ServeHTTP(w, r)
		case ShortedStocksServiceGetStockProcedure:
			shortedStocksServiceGetStockHandler.ServeHTTP(w, r)
		case ShortedStocksServiceGetStockDetailsProcedure:
			shortedStocksServiceGetStockDetailsHandler.ServeHTTP(w, r)
		case ShortedStocksServiceGetStockDataProcedure:
			shortedStocksServiceGetStockDataHandler.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

// UnimplementedShortedStocksServiceHandler returns CodeUnimplemented from all methods.
type UnimplementedShortedStocksServiceHandler struct{}

func (UnimplementedShortedStocksServiceHandler) Top10(context.Context, *connect.Request[v1alpha1.Top10Request]) (*connect.Response[v1alpha1.Top10Response], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("shorts.v1alpha1.ShortedStocksService.Top10 is not implemented"))
}

func (UnimplementedShortedStocksServiceHandler) GetStock(context.Context, *connect.Request[v1alpha1.StockSummaryRequest]) (*connect.Response[v1alpha11.Stock], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("shorts.v1alpha1.ShortedStocksService.GetStock is not implemented"))
}

func (UnimplementedShortedStocksServiceHandler) GetStockDetails(context.Context, *connect.Request[v1alpha1.StockDetailsRequest]) (*connect.Response[v1alpha11.StockDetails], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("shorts.v1alpha1.ShortedStocksService.GetStockDetails is not implemented"))
}

func (UnimplementedShortedStocksServiceHandler) GetStockData(context.Context, *connect.Request[v1alpha1.GetStockDataRequest]) (*connect.Response[v1alpha11.TimeSeriesData], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("shorts.v1alpha1.ShortedStocksService.GetStockData is not implemented"))
}
