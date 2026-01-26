package main

import (
	"context"
	"net/http"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/awslabs/aws-lambda-go-api-proxy/handlerfunc"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/cmd/server/config"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts"
)

var (
	server  *shorts.ShortsServer
	adapter *handlerfunc.HandlerFuncAdapter
)

func registerOps(config *config.Config, mux *http.ServeMux) {
	mux.HandleFunc("/config.json", config.ServeAsJSON)
	mux.HandleFunc("/config.yaml", config.ServeAsYAML)
}

func init() {
	logger := log.NewLogger()
	logger.SetLevel("debug")
	//Get all env variables
	logger.Info("env: %+v", os.Environ())
	cfg, err := config.Load()
	if err != nil {
		logger.Errorf("error loading config, error: %+v", err)
	}
	ctx := context.Background()
	server, err = shorts.New(ctx, cfg.AppSpec)

	if err != nil {
		logger.Errorf("error initialising shorts server, error: %+v", err)
	}
	mux := http.NewServeMux()
	path, handler := shortsv1alpha1connect.NewShortedStocksServiceHandler(server)
	mux.Handle(path, handler)
	registerOps(cfg, mux)
	adapter = handlerfunc.New(mux.ServeHTTP)
}
func main() {

	lambda.Start(func(ctx context.Context, req events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
		// If no name is provided in the HTTP request body, throw an error
		return adapter.ProxyWithContext(ctx, req)
	})
}
